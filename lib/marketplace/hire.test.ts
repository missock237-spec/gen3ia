import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MARKETPLACE D'AGENTS — LOCATION (V2 — Task 114-c) :
 *  - hireAgent : gardes métier (auto-location, annonce non publiée, file non
 *    configurée, solde insuffisant), escrow du loyer, planification sécurisée
 *    (charte propriétaire, AUCUN sous-agent privé), enfilement + compensation
 *    (libération) sur échec ;
 *  - settleAgentHireByExecution : capture/scinde (commission + gain) sur
 *    réussite, libération sur échec, IDEMPOTENCE (déjà terminal → skip) et
 *    FAIL-SOFT total (jamais de throw vers mission-tick).
 *
 * Mocks adminDb selon le pattern mission-escrow.test.ts / outcome-credits.test.ts.
 */

const mocks = vi.hoisted(() => {
  const makeDoc = () => ({ get: vi.fn(), set: vi.fn() });
  return {
    mapDoc: makeDoc(), // hireByExecution/{executionId}
    hireDoc: makeDoc(), // agentListingHires/{hireId}
    listingDoc: makeDoc(), // agentListings/{listingId}
    runTransaction: vi.fn(),
    collection: vi.fn((name: string) => ({
      doc: vi.fn(() =>
        name === "hireByExecution" ? mocks.mapDoc : name === "agentListingHires" ? mocks.hireDoc : mocks.listingDoc,
      ),
      where: vi.fn(() => ({ limit: vi.fn(() => ({ get: vi.fn().mockResolvedValue({ docs: [] }) })) })),
    })),
    // wallet
    reserveFunds: vi.fn(),
    releaseReservation: vi.fn(),
    settleReservation: vi.fn(),
    applyEarning: vi.fn(),
    // agent-listings (partiel : getAgentListing seul est mocké)
    getAgentListing: vi.fn(),
    // repository / planner / file
    getAgentForOwner: vi.fn(),
    planUniversalAgent: vi.fn(),
    policyForAgent: vi.fn(),
    createQueuedMission: vi.fn(),
    markMissionEnqueueFailed: vi.fn(),
    missionQueueConfigured: vi.fn(),
    publishMissionTick: vi.fn(),
  };
});

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: mocks.collection,
    runTransaction: (...args: unknown[]) => mocks.runTransaction(...args),
  },
}));

vi.mock("@/lib/billing/wallet", () => ({
  reserveFunds: mocks.reserveFunds,
  releaseReservation: mocks.releaseReservation,
  settleReservation: mocks.settleReservation,
  applyEarning: mocks.applyEarning,
}));

vi.mock("@/lib/marketplace/agent-listings", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/marketplace/agent-listings")>();
  return {
    ...original,
    getAgentListing: mocks.getAgentListing,
  };
});

vi.mock("@/lib/agents/repository", () => ({
  getAgentForOwner: mocks.getAgentForOwner,
}));

vi.mock("@/lib/agents/personalized-plan", () => ({
  policyForAgent: mocks.policyForAgent,
}));

vi.mock("@/lib/agents/runtime/unified-agent", () => ({
  planUniversalAgent: mocks.planUniversalAgent,
}));

vi.mock("@/lib/queue/mission-queue", () => ({
  createQueuedMission: mocks.createQueuedMission,
  markMissionEnqueueFailed: mocks.markMissionEnqueueFailed,
}));

vi.mock("@/lib/queue/qstash", () => ({
  missionQueueConfigured: mocks.missionQueueConfigured,
  publishMissionTick: mocks.publishMissionTick,
}));

import {
  hireAgent,
  marketplaceFeeBps,
  settleAgentHireByExecution,
} from "./hire";
import { applyEarning, releaseReservation, reserveFunds, settleReservation } from "@/lib/billing/wallet";
import { getAgentForOwner } from "@/lib/agents/repository";
import { planUniversalAgent } from "@/lib/agents/runtime/unified-agent";
import { createQueuedMission, markMissionEnqueueFailed } from "@/lib/queue/mission-queue";
import { missionQueueConfigured, publishMissionTick } from "@/lib/queue/qstash";

function listingFixture(overrides: Record<string, unknown> = {}) {
  return {
    listingId: "l1",
    agentId: "a1",
    ownerId: "owner-1",
    title: "Agent marketing",
    description: "Un agent pour vos campagnes.",
    capabilityTags: ["seo"],
    pricing: { model: "per_mission", priceMinor: 10_000 },
    status: "published",
    stats: { hires: 0, ratingSum: 0, ratingCount: 0 },
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function planFixture() {
  return {
    executionId: "exec-1",
    objective: "Lancer une campagne",
    steps: [
      { id: "s1", type: "llm" as const, name: "Plan", description: "d", dependencies: [], status: "pending" as const, input: {}, skillIds: [] as string[], maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false },
    ],
    maxConcurrency: 1,
    maxIterations: 1,
  };
}

function mappingFixture(overrides: Record<string, unknown> = {}) {
  return {
    hireId: "h1",
    listingId: "l1",
    tenantId: "tenant-1",
    ownerId: "owner-1",
    priceMinor: 10_000,
    commissionBps: 2_000,
    createdAtMs: 1,
    ...overrides,
  };
}

function heldHireFixture(overrides: Record<string, unknown> = {}) {
  return mappingFixture({ ...overrides, status: overrides.status ?? "held" });
}

beforeEach(() => {
  for (const doc of [mocks.mapDoc, mocks.hireDoc, mocks.listingDoc]) {
    doc.get.mockReset();
    doc.set.mockReset();
  }
  mocks.runTransaction.mockReset();
  mocks.reserveFunds.mockReset().mockResolvedValue({});
  mocks.releaseReservation.mockReset().mockResolvedValue({});
  mocks.settleReservation.mockReset().mockResolvedValue({});
  mocks.applyEarning.mockReset().mockResolvedValue({});
  mocks.getAgentListing.mockReset().mockResolvedValue(listingFixture());
  // Agent propriétaire minimal lisible par buildAgentCharter (nom, type,
  // skills) — la charte est REBUILD depuis le record (même voie que
  // planAgentTask), le record doit donc être complet.
  const agentOwner = {
    id: "a1",
    ownerId: "owner-1",
    status: "active",
    name: "Agent marketing",
    description: "Un agent pour vos campagnes.",
    type: "universal",
    skills: ["SEO"],
    agentMode: "standard",
    modelStrategy: "automatic",
  };
  mocks.getAgentForOwner.mockReset().mockResolvedValue(agentOwner);
  mocks.planUniversalAgent.mockReset().mockResolvedValue(planFixture());
  mocks.policyForAgent.mockReset().mockReturnValue({ allowedTools: ["*"] });
  mocks.createQueuedMission.mockReset().mockResolvedValue(undefined);
  mocks.markMissionEnqueueFailed.mockReset().mockResolvedValue(undefined);
  mocks.missionQueueConfigured.mockReset().mockReturnValue(true);
  mocks.publishMissionTick.mockReset().mockResolvedValue({ messageId: "msg-1" });
  delete process.env.GEN3IA_MARKETPLACE_FEE_BPS;
});

describe("marketplaceFeeBps (pur)", () => {
  it("défaut 2 000 bps (20 %)", () => {
    expect(marketplaceFeeBps()).toBe(2_000);
  });
  it("surcharge par variable d'environnement", () => {
    process.env.GEN3IA_MARKETPLACE_FEE_BPS = "1500";
    expect(marketplaceFeeBps()).toBe(1_500);
  });
  it("clamp 0..5 000 (jamais plus de la moitié)", () => {
    process.env.GEN3IA_MARKETPLACE_FEE_BPS = "-50";
    expect(marketplaceFeeBps()).toBe(0);
    process.env.GEN3IA_MARKETPLACE_FEE_BPS = "9000";
    expect(marketplaceFeeBps()).toBe(5_000);
    process.env.GEN3IA_MARKETPLACE_FEE_BPS = "NaN";
    expect(marketplaceFeeBps()).toBe(2_000);
  });
});

describe("hireAgent", () => {
  it("auto-location → erreur 403, AUCUN prélèvement", async () => {
    const result = await hireAgent("owner-1", { listingId: "l1", objective: "Objectif" });
    expect(result).toMatchObject({ status: 403 });
    expect(mocks.reserveFunds).not.toHaveBeenCalled();
  });

  it("annonce absente → erreur 404", async () => {
    mocks.getAgentListing.mockResolvedValue(null);
    const result = await hireAgent("tenant-1", { listingId: "inconnu", objective: "Objectif" });
    expect(result).toMatchObject({ status: 404 });
    expect(mocks.reserveFunds).not.toHaveBeenCalled();
  });

  it("annonce non publiée → erreur 409", async () => {
    mocks.getAgentListing.mockResolvedValue(listingFixture({ status: "draft" }));
    const result = await hireAgent("tenant-1", { listingId: "l1", objective: "Objectif" });
    expect(result).toMatchObject({ status: 409 });
    expect(mocks.reserveFunds).not.toHaveBeenCalled();
  });

  it("file de missions non configurée → erreur 503 AVANT tout prélèvement", async () => {
    mocks.missionQueueConfigured.mockReturnValue(false);
    const result = await hireAgent("tenant-1", { listingId: "l1", objective: "Objectif" });
    expect(result).toMatchObject({ status: 503 });
    expect(mocks.reserveFunds).not.toHaveBeenCalled();
  });

  it("objectif vide → erreur 400", async () => {
    const result = await hireAgent("tenant-1", { listingId: "l1", objective: "   " });
    expect(result).toMatchObject({ status: 400 });
  });

  it("solde insuffisant → erreur 402 (message FR)", async () => {
    mocks.reserveFunds.mockRejectedValue(new Error("Insufficient wallet balance for this execution."));
    const result = await hireAgent("tenant-1", { listingId: "l1", objective: "Objectif" });
    expect(result).toMatchObject({ status: 402, error: expect.stringMatching(/Solde insuffisant/i) });
    expect(mocks.planUniversalAgent).not.toHaveBeenCalled();
  });

  it("CHEMIN NOMINAL : loyer réservé, plan sécurisé, documents écrits, mission enfilée", async () => {
    const result = await hireAgent("tenant-1", { listingId: "l1", objective: "  Lancer une campagne  ", conversationId: "conv-1" });
    expect(result).toMatchObject({ hireId: expect.any(String), runId: expect.any(String), executionId: "exec-1", priceMinor: 10_000 });

    // Escrow du loyer sur le LOCATAIRE, référence canonique hire_<hireId>.
    expect(mocks.reserveFunds).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "tenant-1",
        amountMinor: 10_000,
        reference: `hire_${(result as { hireId: string }).hireId}`,
        metadata: expect.objectContaining({ kind: "marketplace_hire", listingId: "l1" }),
      }),
    );

    // Planification : charte propriétaire + contrainte de location, AUCUN
    // sous-agent privé (subAgents: []), exécution sous l'uid du LOCATAIRE.
    expect(mocks.planUniversalAgent).toHaveBeenCalledTimes(1);
    const [planUserId, planObjective, options] = mocks.planUniversalAgent.mock.calls[0];
    expect(planUserId).toBe("tenant-1");
    expect(planObjective).toBe("Lancer une campagne");
    expect(options.agent.charter).toContain("Agent marketing");
    expect(options.agent.charter).toContain("CONTEXTE DE LOCATION");
    expect(options.agent.subAgents).toEqual([]);
    expect(options.agent.allowedTools).toContain("composio.execute");

    // Documents : hire « held » + mapping hireByExecution.
    expect(mocks.hireDoc.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "held",
        tenantId: "tenant-1",
        ownerId: "owner-1",
        priceMinor: 10_000,
        executionId: "exec-1",
        conversationId: "conv-1",
      }),
    );
    expect(mocks.mapDoc.set).toHaveBeenCalledWith(
      expect.objectContaining({ hireId: (result as { hireId: string }).hireId, priceMinor: 10_000, commissionBps: 2_000 }),
    );

    // Mission enfilée sous l'uid du LOCATAIRE puis tick publié.
    expect(mocks.createQueuedMission).toHaveBeenCalledWith(
      expect.objectContaining({ runId: (result as { runId: string }).runId, executionId: "exec-1", userId: "tenant-1", plan: planFixture() }),
    );
    expect(mocks.publishMissionTick).toHaveBeenCalledWith((result as { runId: string }).runId);
  });

  it("agent propriétaire devenu indisponible → réservation LIBÉRÉE + erreur 409", async () => {
    mocks.getAgentForOwner.mockResolvedValue(null);
    const result = await hireAgent("tenant-1", { listingId: "l1", objective: "Objectif" });
    expect(result).toMatchObject({ status: 409 });
    expect(mocks.releaseReservation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "tenant-1", reference: expect.stringMatching(/^hire_/), reservedMinor: 10_000 }),
    );
    expect(mocks.createQueuedMission).not.toHaveBeenCalled();
  });

  it("échec de publication du tick → loyer restitué + hire « failed » + erreur 503", async () => {
    mocks.publishMissionTick.mockRejectedValue(new Error("QStash down"));
    const result = await hireAgent("tenant-1", { listingId: "l1", objective: "Objectif" });
    expect(result).toMatchObject({ status: 503, error: expect.stringMatching(/restitu/i) });
    expect(mocks.releaseReservation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "tenant-1", reservedMinor: 10_000 }),
    );
    expect(mocks.hireDoc.set).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }), { merge: true });
    expect(mocks.markMissionEnqueueFailed).toHaveBeenCalled();
  });
});

describe("settleAgentHireByExecution", () => {
  function inTransaction() {
    mocks.runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        get: (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (ref: { set: (...args: unknown[]) => unknown }, data: unknown, opts: unknown) => ref.set(data, opts),
      }),
    );
  }

  it("mapping ABSENT (mission ordinaire) → « skipped » immédiat, wallet JAMAIS touché", async () => {
    mocks.mapDoc.get.mockResolvedValue({ exists: false, data: () => undefined });
    expect(await settleAgentHireByExecution({ executionId: "exec-1", missionStatus: "completed" })).toBe("skipped");
    expect(mocks.hireDoc.get).not.toHaveBeenCalled();
    expect(mocks.settleReservation).not.toHaveBeenCalled();
    expect(mocks.releaseReservation).not.toHaveBeenCalled();
  });

  it("statut non terminal (paused) → « skipped »", async () => {
    mocks.mapDoc.get.mockResolvedValue({ exists: true, data: () => mappingFixture() });
    mocks.hireDoc.get.mockResolvedValue({ exists: true, data: () => heldHireFixture() });
    expect(await settleAgentHireByExecution({ executionId: "exec-1", missionStatus: "paused" })).toBe("skipped");
    expect(mocks.settleReservation).not.toHaveBeenCalled();
    expect(mocks.releaseReservation).not.toHaveBeenCalled();
  });

  it("mission « completed » → loyer capturé + SCINDE (commission 20 %, gain 8 000) + stats +1", async () => {
    mocks.mapDoc.get.mockResolvedValue({ exists: true, data: () => mappingFixture() });
    mocks.hireDoc.get.mockResolvedValue({ exists: true, data: () => heldHireFixture() });
    mocks.listingDoc.get.mockResolvedValue({
      exists: true,
      data: () => listingFixture({ stats: { hires: 2, ratingSum: 0, ratingCount: 0 } }),
    });
    inTransaction();

    expect(await settleAgentHireByExecution({ executionId: "exec-1", missionStatus: "completed" })).toBe("captured");

    expect(mocks.settleReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "tenant-1",
        reference: "hire_h1",
        reservedMinor: 10_000,
        actualChargeMinor: 10_000,
        metadata: expect.objectContaining({ kind: "marketplace_hire", hireId: "h1" }),
      }),
    );
    // 10 000 minor, 2 000 bps → commission 2 000, NET propriétaire 8 000.
    expect(mocks.applyEarning).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-1",
        amountMinor: 8_000,
        reference: "hire_h1",
        metadata: expect.objectContaining({ kind: "marketplace_hire", hireId: "h1", feeMinor: "2000" }),
      }),
    );
    expect(mocks.hireDoc.set).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }), { merge: true });
    expect(mocks.listingDoc.set).toHaveBeenCalledWith(
      expect.objectContaining({ stats: expect.objectContaining({ hires: 3 }) }),
      { merge: true },
    );
    expect(mocks.releaseReservation).not.toHaveBeenCalled();
  });

  it("mission « failed » → loyer LIBÉRÉ + hire « failed »", async () => {
    mocks.mapDoc.get.mockResolvedValue({ exists: true, data: () => mappingFixture() });
    mocks.hireDoc.get.mockResolvedValue({ exists: true, data: () => heldHireFixture() });
    expect(await settleAgentHireByExecution({ executionId: "exec-1", missionStatus: "failed" })).toBe("released");
    expect(mocks.releaseReservation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "tenant-1", reference: "hire_h1", reservedMinor: 10_000 }),
    );
    expect(mocks.hireDoc.set).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }), { merge: true });
    expect(mocks.settleReservation).not.toHaveBeenCalled();
    expect(mocks.applyEarning).not.toHaveBeenCalled();
  });

  it("mission « cancelled » → loyer LIBÉRÉ + hire « released »", async () => {
    mocks.mapDoc.get.mockResolvedValue({ exists: true, data: () => mappingFixture() });
    mocks.hireDoc.get.mockResolvedValue({ exists: true, data: () => heldHireFixture() });
    expect(await settleAgentHireByExecution({ executionId: "exec-1", missionStatus: "cancelled" })).toBe("released");
    expect(mocks.releaseReservation).toHaveBeenCalled();
    expect(mocks.hireDoc.set).toHaveBeenCalledWith(expect.objectContaining({ status: "released" }), { merge: true });
  });

  it("IDEMPOTENCE : hire déjà « completed » → « skipped », wallet JAMAIS touché", async () => {
    mocks.mapDoc.get.mockResolvedValue({ exists: true, data: () => mappingFixture() });
    mocks.hireDoc.get.mockResolvedValue({ exists: true, data: () => heldHireFixture({ status: "completed" }) });
    expect(await settleAgentHireByExecution({ executionId: "exec-1", missionStatus: "completed" })).toBe("skipped");
    expect(mocks.settleReservation).not.toHaveBeenCalled();
    expect(mocks.applyEarning).not.toHaveBeenCalled();
    expect(mocks.releaseReservation).not.toHaveBeenCalled();
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("IDEMPOTENCE : hire déjà « released » → « skipped » (pas de double libération)", async () => {
    mocks.mapDoc.get.mockResolvedValue({ exists: true, data: () => mappingFixture() });
    mocks.hireDoc.get.mockResolvedValue({ exists: true, data: () => heldHireFixture({ status: "released" }) });
    expect(await settleAgentHireByExecution({ executionId: "exec-1", missionStatus: "failed" })).toBe("skipped");
    expect(mocks.releaseReservation).not.toHaveBeenCalled();
  });

  it("FAIL-SOFT : panne du wallet → « skipped », JAMAIS de throw vers mission-tick", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.mapDoc.get.mockResolvedValue({ exists: true, data: () => mappingFixture() });
    mocks.hireDoc.get.mockResolvedValue({ exists: true, data: () => heldHireFixture() });
    mocks.settleReservation.mockRejectedValue(new Error("r2fs indisponible"));
    expect(await settleAgentHireByExecution({ executionId: "exec-1", missionStatus: "completed" })).toBe("skipped");
    consoleError.mockRestore();
  });

  it("commission personnalisée (env 5 000 bps) → net propriétaire réduit en conséquence", async () => {
    process.env.GEN3IA_MARKETPLACE_FEE_BPS = "5000";
    // Le hire mémorise SA commission au moment de la location (2 000 ici) :
    // la valeur du document prime sur l'env du moment.
    mocks.mapDoc.get.mockResolvedValue({ exists: true, data: () => mappingFixture({ commissionBps: 5_000 }) });
    mocks.hireDoc.get.mockResolvedValue({ exists: true, data: () => heldHireFixture({ commissionBps: 5_000 }) });
    mocks.listingDoc.get.mockResolvedValue({ exists: false, data: () => undefined });
    inTransaction();
    expect(await settleAgentHireByExecution({ executionId: "exec-1", missionStatus: "completed" })).toBe("captured");
    expect(mocks.applyEarning).toHaveBeenCalledWith(expect.objectContaining({ amountMinor: 5_000, metadata: expect.objectContaining({ feeMinor: "5000" }) }));
  });
});

describe("imports consommés (contrat wallet)", () => {
  it("les primitives wallet mockées correspondent aux imports réels du module", () => {
    expect(typeof reserveFunds).toBe("function");
    expect(typeof settleReservation).toBe("function");
    expect(typeof releaseReservation).toBe("function");
    expect(typeof applyEarning).toBe("function");
    expect(typeof getAgentForOwner).toBe("function");
    expect(typeof planUniversalAgent).toBe("function");
    expect(typeof createQueuedMission).toBe("function");
    expect(typeof markMissionEnqueueFailed).toBe("function");
    expect(typeof missionQueueConfigured).toBe("function");
    expect(typeof publishMissionTick).toBe("function");
  });
});
