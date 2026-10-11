import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ANALYTIQUE PAR AGENT (Task 131) — contrat vérifié SANS vraie persistance :
 * transaction atomique (compteurs FieldValue.increment + fenêtre de latence
 * bornée 500), fail-soft strict (recordAgentTurn ne lève JAMAIS), lecture
 * agrégée multi-jours avec p50/p95 calculés depuis les échantillons stockés.
 *
 * Le VRAI runFirestoreGuarded est utilisé (deadline + disjoncteur réels) :
 * le disjoncteur est réinitialisé entre chaque test, comme
 * lib/queue/mission-queue.guard.test.ts.
 */

const mocks = vi.hoisted(() => ({
  docGet: vi.fn(),
  txGet: vi.fn(),
  txSet: vi.fn(),
  runTransaction: vi.fn(),
  collectionName: vi.fn(),
  docIds: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => {
      mocks.collectionName(name);
      return {
        doc: (id: string) => {
          mocks.docIds(id);
          return { id, get: mocks.docGet };
        },
      };
    },
    runTransaction: (fn: unknown) => mocks.runTransaction(fn),
  },
}));

vi.mock("@/lib/r2fs", () => ({
  FieldValue: {
    increment: (n: number) => ({ __increment: n }),
    serverTimestamp: () => ({ __ts: true }),
  },
}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: mocks.loggerWarn, info: vi.fn(), error: vi.fn() },
}));

import { resetQuotaGuardForTests } from "@/lib/db/quota-guard";
import {
  ANALYTICS_DEFAULT_DAYS,
  LATENCY_SAMPLE_WINDOW,
  getAgentAnalytics,
  idDocAnalytics,
  jourIsoUtc,
  recordAgentTurn,
} from "./analytics";

/** Transaction simulée : le callback reçoit un tx { get, set } comme r2fs. */
function transactionSimulee(): void {
  mocks.runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
    fn({ get: (ref: unknown) => mocks.txGet(ref), set: (...args: unknown[]) => mocks.txSet(...args) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetQuotaGuardForTests();
  mocks.docGet.mockReset();
  mocks.txGet.mockResolvedValue({ exists: false, data: () => undefined });
  mocks.txSet.mockResolvedValue(undefined);
  transactionSimulee();
});

describe("identifiants déterministes", () => {
  it("jourIsoUtc formate en YYYY-MM-DD ; id de doc = {agentId}_{jour}", () => {
    const instant = new Date("2026-03-09T23:59:59.999Z");
    expect(jourIsoUtc(instant)).toBe("2026-03-09");
    expect(idDocAnalytics("agent-7", instant)).toBe("agent-7_2026-03-09");
  });
});

describe("recordAgentTurn — écriture atomique fail-soft", () => {
  it("incrémente les compteurs du document quotidien en une seule transaction", async () => {
    mocks.txGet.mockResolvedValue({ exists: true, data: () => ({ latencySamples: [120, 340] }) });
    await recordAgentTurn({
      agentId: "agent-1",
      conversationId: "conv-9",
      latencyMs: 480.6,
      tokensIn: 210,
      tokensOut: 90,
      toolCalls: 2,
      errors: 0,
      mode: "chat",
    });

    expect(mocks.collectionName).toHaveBeenCalledWith("agentAnalytics");
    expect(String(mocks.docIds.mock.calls.at(-1))).toMatch(/^agent-1_\d{4}-\d{2}-\d{2}$/);
    expect(mocks.txSet).toHaveBeenCalledTimes(1);

    const data = mocks.txSet.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(data).toEqual(expect.objectContaining({
      agentId: "agent-1",
      messages: { __increment: 1 },
      toolCalls: { __increment: 2 },
      errors: { __increment: 0 },
      latencyMsSum: { __increment: 481 }, // latence arrondie au millième
      latencySamples: [120, 340, 481],
      tokensIn: { __increment: 210 },
      tokensOut: { __increment: 90 },
      lastConversationId: "conv-9",
      "modes.chat": { __increment: 1 },
    }));
    expect(mocks.txSet.mock.calls[0]?.[2]).toEqual({ merge: true });
  });

  it("sans mode ni conversation : aucun champ optionnel n'est écrit", async () => {
    await recordAgentTurn({ agentId: "agent-2", latencyMs: 50 });
    const data = mocks.txSet.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(data).not.toHaveProperty("modes.chat");
    expect(data).not.toHaveProperty("lastConversationId");
  });

  it("maintient la fenêtre de latence bornée (500 échantillons, le plus récent en dernier)", async () => {
    const sixCents = Array.from({ length: LATENCY_SAMPLE_WINDOW + 100 }, (_, i) => i + 1);
    mocks.txGet.mockResolvedValue({ exists: true, data: () => ({ latencySamples: sixCents }) });
    await recordAgentTurn({ agentId: "agent-3", latencyMs: 950 });

    const data = mocks.txSet.mock.calls[0]?.[1] as { latencySamples: number[] };
    expect(data.latencySamples).toHaveLength(LATENCY_SAMPLE_WINDOW);
    expect(data.latencySamples.at(-1)).toBe(950);
    // les échantillons les plus ANCIENS sont évacués, pas les récents
    expect(data.latencySamples.at(0)).toBe(102);
  });

  it("ignore les échantillons corrompus déjà stockés (défense en profondeur)", async () => {
    mocks.txGet.mockResolvedValue({ exists: true, data: () => ({ latencySamples: ["x", 120, null, 340] }) });
    await recordAgentTurn({ agentId: "agent-4", latencyMs: 77 });
    const data = mocks.txSet.mock.calls[0]?.[1] as { latencySamples: number[] };
    expect(data.latencySamples).toEqual([120, 340, 77]);
  });

  it("avale toute erreur avec un log warn — JAMAIS d'impact sur le chat", async () => {
    mocks.runTransaction.mockRejectedValue(new Error("Firestore sous quota : disjoncteur ouvert, appel court-circuité."));
    await expect(recordAgentTurn({ agentId: "agent-5", latencyMs: 10 })).resolves.toBeUndefined();
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    // et une panne AVANT la transaction (garde) est avalée de la même façon
    mocks.runTransaction.mockReset();
    mocks.runTransaction.mockImplementation(() => { throw new Error("boom"); });
    await expect(recordAgentTurn({ agentId: "agent-5", latencyMs: 10 })).resolves.toBeUndefined();
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(2);
  });
});

describe("getAgentAnalytics — lecture agrégée", () => {
  it("agrège les totaux, calcule p50/p95 depuis les samples et tient la série chronologique", async () => {
    // Ordre des lectures du module : aujourd'hui, hier, avant-hier.
    mocks.docGet
      .mockImplementationOnce(async () => ({
        exists: true,
        data: () => ({ messages: 3, toolCalls: 5, errors: 1, tokensIn: 100, tokensOut: 50, latencyMsSum: 1_000, latencySamples: [400, 100, 300, 200] }),
      }))
      .mockImplementationOnce(async () => ({
        exists: true,
        data: () => ({ messages: 1, toolCalls: 2, errors: 0, tokensIn: 20, tokensOut: 10, latencyMsSum: 150, latencySamples: [150] }),
      }))
      .mockImplementationOnce(async () => ({ exists: false, data: () => undefined }));

    const summary = await getAgentAnalytics("agent-1", 3);

    expect(summary.days).toBe(3);
    expect(summary.messages).toBe(4);
    expect(summary.toolCalls).toBe(7);
    expect(summary.errors).toBe(1);
    expect(summary.tokensIn).toBe(120);
    expect(summary.tokensOut).toBe(60);
    // samples cumulés triés : [100, 150, 200, 300, 400]
    expect(summary.latency.samples).toBe(5);
    expect(summary.latency.p50Ms).toBe(200);
    expect(summary.latency.p95Ms).toBe(400);
    expect(summary.latency.avgMs).toBe(230);

    // Série chronologique : le DERNIER point est aujourd'hui (premier lu).
    expect(summary.daily).toHaveLength(3);
    expect(summary.daily[2]).toEqual(expect.objectContaining({ messages: 3, toolCalls: 5, latencyAvgMs: 250 }));
    expect(summary.daily[1]).toEqual(expect.objectContaining({ messages: 1, latencyAvgMs: 150 }));
    expect(summary.daily[0]).toEqual(expect.objectContaining({ messages: 0, toolCalls: 0, latencyAvgMs: null }));
    expect(summary.daily[0]!.dayIso < summary.daily[1]!.dayIso).toBe(true);
    expect(summary.daily[1]!.dayIso < summary.daily[2]!.dayIso).toBe(true);
  });

  it("sans aucune donnée : totaux à zéro, latences nulles, série vide de flux", async () => {
    mocks.docGet.mockResolvedValue({ exists: false, data: () => undefined });
    const summary = await getAgentAnalytics("agent-x", ANALYTICS_DEFAULT_DAYS);
    expect(summary.messages).toBe(0);
    expect(summary.latency.avgMs).toBeNull();
    expect(summary.latency.p50Ms).toBeNull();
    expect(summary.latency.p95Ms).toBeNull();
    expect(summary.daily.every((point) => point.messages === 0)).toBe(true);
    expect(mocks.docGet).toHaveBeenCalledTimes(ANALYTICS_DEFAULT_DAYS);
  });

  it("borne l'horizon de lecture (minimum 1 jour, maximum 90)", async () => {
    mocks.docGet.mockResolvedValue({ exists: false, data: () => undefined });
    await getAgentAnalytics("agent-y", 0);
    expect(mocks.docGet).toHaveBeenCalledTimes(1);
    mocks.docGet.mockClear();
    await getAgentAnalytics("agent-y", 500);
    expect(mocks.docGet).toHaveBeenCalledTimes(90);
  });

  it("propage l'erreur de lecture (traduite par la route API en 503)", async () => {
    mocks.docGet.mockRejectedValue(new Error("agent analytics read: aucune réponse en 6000ms (probablement quota Firestore épuisé)."));
    await expect(getAgentAnalytics("agent-z", 2)).rejects.toThrow(/quota Firestore/);
  });
});
