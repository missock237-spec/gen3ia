import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Garde quota des approbations HITL (Task 110-e).
 *
 * Les approbations (`agentActionApprovals`) restent sur FIRESTORE et étaient
 * la dernière famille d'appels BRUTS du flux waiting_approval du chat :
 * createActionApproval (écriture, route.ts ~700/1050 — pendait la requête
 * chat sous stall Firestore), listActionApprovals (requêtes, route.ts
 * 850/867/1167/1183) et les transactions de décision (approve/reject/claim/
 * complete/fail — pendait la reprise de mission après approbation).
 *
 * Contrat après fix : chaque touche est bornée (6 s) et quota-classifiée
 * (disjoncteur Task 95-b), via le MÊME runFirestoreGuarded que la file de
 * missions (aucune duplication). Verrous rouges sur l'arbre sans garde.
 */

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  queryGet: vi.fn(),
  runTransaction: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ create: mocks.create, get: mocks.get })),
      where: vi.fn(() => ({
        where: vi.fn(() => ({ get: mocks.queryGet })),
      })),
    })),
    runTransaction: mocks.runTransaction,
  },
}));

vi.mock("@/lib/integrations/webhooks/emit", () => ({
  emitOutgoingEventSafe: vi.fn(),
}));

vi.mock("@/lib/integrations/messaging/notify", () => ({
  notifyApprovalRequested: vi.fn(),
  notifyApprovalResolved: vi.fn(),
}));

vi.mock("@/lib/notifications/repository", () => ({
  createNotification: vi.fn(async () => null),
  markNotificationsForApprovalRead: vi.fn(async () => undefined),
}));

const quotaError = () => Object.assign(new Error("Quota exceeded for quota group 'default'."), { code: 8 });

function openBreaker(): void {
  noteFirestoreQuotaError(quotaError());
  noteFirestoreQuotaError(quotaError());
  noteFirestoreQuotaError(quotaError());
}

beforeEach(() => {
  vi.useFakeTimers();
  resetQuotaGuardForTests();
  mocks.create.mockReset();
  mocks.get.mockReset();
  mocks.queryGet.mockReset();
  mocks.runTransaction.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

import { getQuotaGuardStats, noteFirestoreQuotaError, resetQuotaGuardForTests } from "@/lib/db/quota-guard";
import {
  createActionApproval,
  listActionApprovals,
  approveAction,
  type ActionApproval,
} from "./action-approvals";

const CREATE_INPUT = {
  ownerId: "user-1",
  executionId: "exec-110e",
  role: "admin" as const,
  toolSlug: "web.api.write",
  arguments: { __stepId: "s1" },
  reason: "Publication externe requise",
};

const SNAPSHOT = {
  exists: true,
  id: "appr-1",
  get: (field: string) =>
    field === "ownerId" ? "user-1" : field === "status" ? "pending" : field === "expiresAt" ? { toMillis: () => Date.now() + 600_000 } : undefined,
  data: () => ({
    ownerId: "user-1",
    executionId: "exec-110e",
    role: "admin",
    toolSlug: "web.api.write",
    arguments: { __stepId: "s1" },
    reason: "Publication externe requise",
    status: "pending",
    createdAt: { toMillis: () => 1 },
    expiresAt: { toMillis: () => Date.now() + 600_000 },
  }),
};

/** Résultat d'un appel potentiellement PENDANT (stall) : rejet au délai du garde ou timeout du test. */
async function outcomeWithinDeadline(pending: Promise<unknown>): Promise<string> {
  return Promise.race([
    pending.then(
      () => "resolved" as const,
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}` as const,
    ),
    vi.advanceTimersByTimeAsync(7_000).then(() => "timeout" as const),
  ]);
}

describe("createActionApproval sous garde (110-e)", () => {
  it("VERROU 110-e : disjoncteur ouvert → rejet immédiat quota-classifié, Firestore JAMAIS touché", async () => {
    openBreaker();
    mocks.create.mockResolvedValue(undefined);
    await expect(createActionApproval(CREATE_INPUT)).rejects.toThrow("Firestore sous quota");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : écriture qui pend (quota quotidien) → rejet quota-classifié au délai + disjoncteur ouvert", async () => {
    mocks.create.mockImplementation(() => new Promise<void>(() => undefined)); // stall : ne répond JAMAIS
    const outcome = await outcomeWithinDeadline(createActionApproval(CREATE_INPUT));
    expect(outcome).toMatch(/^rejected:/);
    expect(outcome).toContain("quota");
    expect(getQuotaGuardStats().state).toBe("open");
  });

  it("chemin nominal inchangé : création + relecture (régression)", async () => {
    mocks.create.mockResolvedValue(undefined);
    mocks.get.mockResolvedValue(SNAPSHOT);
    const approval = await createActionApproval(CREATE_INPUT);
    expect(approval.id).toBe("appr-1");
    expect(approval.status).toBe("pending");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(getQuotaGuardStats().state).toBe("closed");
  });
});

describe("listActionApprovals sous garde (110-e)", () => {
  it("VERROU 110-e : disjoncteur ouvert → rejet immédiat, requête JAMAIS émise", async () => {
    openBreaker();
    mocks.queryGet.mockResolvedValue({ docs: [] });
    await expect(listActionApprovals("user-1", "exec-110e")).rejects.toThrow("Firestore sous quota");
    expect(mocks.queryGet).not.toHaveBeenCalled();
  });

  it("chemin nominal inchangé : liste propriétaire (régression)", async () => {
    mocks.queryGet.mockResolvedValue({ docs: [{ id: "appr-1" }] });
    mocks.get.mockResolvedValue(SNAPSHOT);
    const approvals = await listActionApprovals("user-1", "exec-110e");
    expect(approvals).toHaveLength(1);
    expect((approvals as ActionApproval[])[0].toolSlug).toBe("web.api.write");
  });
});

describe("décisions d'approbation sous garde (110-e)", () => {
  it("VERROU 110-e : approveAction, disjoncteur ouvert → transaction JAMAIS ouverte", async () => {
    openBreaker();
    mocks.runTransaction.mockResolvedValue(undefined);
    await expect(approveAction("user-1", "appr-1")).rejects.toThrow("Firestore sous quota");
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : transaction qui pend → rejet quota-classifié au délai (reprise de mission plus jamais pendue)", async () => {
    mocks.runTransaction.mockImplementation(() => new Promise(() => undefined)); // stall
    const outcome = await outcomeWithinDeadline(approveAction("user-1", "appr-1"));
    expect(outcome).toMatch(/^rejected:/);
    expect(outcome).toContain("quota");
    expect(getQuotaGuardStats().state).toBe("open");
  });

  it("chemin nominal inchangé : transaction + relecture (régression)", async () => {
    mocks.runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: vi.fn().mockResolvedValue({ exists: true, get: SNAPSHOT.get }),
        update: vi.fn(),
      }),
    );
    mocks.get.mockResolvedValue({ ...SNAPSHOT, data: () => ({ ...SNAPSHOT.data(), status: "approved" }), get: (field: string) => (field === "status" ? "approved" : SNAPSHOT.get(field)) });
    const approval = await approveAction("user-1", "appr-1");
    expect(approval.status).toBe("approved");
    expect(mocks.runTransaction).toHaveBeenCalledTimes(1);
  });
});
