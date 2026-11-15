import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests du module queue-resume (Task 95-c/d, adapté Task 108) — reprise
 * quota-aware des files.
 *
 * Patterns : couche résiliente Firestore-only mockée en vi.fn pour valider
 * les wrappers, quota-guard RÉEL pour la classification (reset entre tests).
 * Le miroir secondaire (claim atomique + réconciliation) a été supprimé avec
 * le second backend (Task 108) : sous quota, les ticks sont neutralisés puis
 * republiés (routes + sweep + cron).
 */

// ---------------------------------------------------------------------------
// État hoisted — couche résiliente mockée (wrappers)
// ---------------------------------------------------------------------------

const resilientMocks = vi.hoisted(() => ({
  resilientGet: vi.fn(),
  resilientSet: vi.fn(),
  resilientCreate: vi.fn(),
  resilientQuery: vi.fn(),
}));

vi.mock("@/lib/db/firestore-resilient", () => resilientMocks);

// ---------------------------------------------------------------------------
// Sujet sous test
// ---------------------------------------------------------------------------

import {
  QUOTA_BACKOFF_CAP_SECONDS,
  QUOTA_BACKOFF_BASE_SECONDS,
  TRANSIENT_DELAY_SECONDS,
  classifyTickError,
  createJobDoc,
  loadJobDoc,
  queryJobDocs,
  resumePolicyFor,
  saveJobDoc,
} from "./queue-resume";

function quotaError(message = "Quota exceeded for quota group 'default'."): Error {
  return Object.assign(new Error(message), { code: 8 });
}

function transientError(): Error {
  return Object.assign(new Error("The service is currently unavailable."), { code: 14 });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// classifyTickError
// ---------------------------------------------------------------------------

describe("classifyTickError", () => {
  it("classe les erreurs de QUOTA (gRPC 8, 429, RESOURCE_EXHAUSTED, message)", () => {
    expect(classifyTickError(quotaError())).toBe("quota");
    expect(classifyTickError(Object.assign(new Error("Too Many Requests"), { code: 429 }))).toBe("quota");
    expect(classifyTickError(Object.assign(new Error("x"), { code: "RESOURCE_EXHAUSTED" }))).toBe("quota");
    expect(classifyTickError(new Error("Quota exceeded for quota group 'ReadRequests'"))).toBe("quota");
    expect(classifyTickError(new Error("Firestore sous quota : disjoncteur ouvert, appel court-circuité (reprise après cooldown)."))).toBe("quota");
    // cause imbriquée
    const nested = new Error("wrapper", { cause: quotaError() });
    expect(classifyTickError(nested)).toBe("quota");
  });

  it("classe les incidents TRANSITOIRES (UNAVAILABLE, deadline, réseau)", () => {
    expect(classifyTickError(transientError())).toBe("transient");
    expect(classifyTickError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe("transient");
    expect(classifyTickError(new Error("Deadline exceeded during call"))).toBe("transient");
  });

  it("classe le reste en FATAL (jamais un métier en quota)", () => {
    expect(classifyTickError(new Error("Permission denied on document"))).toBe("fatal");
    expect(classifyTickError(new Error("Scénario absent au moment du rendu."))).toBe("fatal");
    expect(classifyTickError("chaîne brute")).toBe("fatal");
  });
});

// ---------------------------------------------------------------------------
// resumePolicyFor
// ---------------------------------------------------------------------------

describe("resumePolicyFor", () => {
  it("QUOTA : backoff exponentiel 30 → 60 → 120 → … plafonné à 900", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // gigue nulle → valeurs exactes
    expect(resumePolicyFor(quotaError(), 0).delaySeconds).toBe(QUOTA_BACKOFF_BASE_SECONDS);
    expect(resumePolicyFor(quotaError(), 1).delaySeconds).toBe(60);
    expect(resumePolicyFor(quotaError(), 2).delaySeconds).toBe(120);
    expect(resumePolicyFor(quotaError(), 3).delaySeconds).toBe(240);
    expect(resumePolicyFor(quotaError(), 10).delaySeconds).toBe(QUOTA_BACKOFF_CAP_SECONDS);
  });

  it("QUOTA : gigue bornée 0..5 s (jamais au-delà du cap + 5)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    expect(resumePolicyFor(quotaError(), 10).delaySeconds).toBe(QUOTA_BACKOFF_CAP_SECONDS + 5);
    vi.restoreAllMocks();
    for (let n = 0; n <= 12; n += 1) {
      const base = Math.min(QUOTA_BACKOFF_BASE_SECONDS * 2 ** n, QUOTA_BACKOFF_CAP_SECONDS);
      const policy = resumePolicyFor(quotaError(), n);
      expect(policy.delaySeconds).toBeGreaterThanOrEqual(base);
      expect(policy.delaySeconds).toBeLessThanOrEqual(base + 5);
    }
  });

  it("QUOTA : budget NON consommé, PAS de notification", () => {
    const policy = resumePolicyFor(quotaError(), 1);
    expect(policy.consumeRetry).toBe(false);
    expect(policy.notifyFailure).toBe(false);
  });

  it("TRANSITOIRE : délai fixe 15 s, budget NON consommé, pas de notification", () => {
    const policy = resumePolicyFor(transientError(), 0);
    expect(policy).toEqual({ consumeRetry: false, delaySeconds: TRANSIENT_DELAY_SECONDS, notifyFailure: false });
  });

  it("FATAL : régime legacy (budget consommé + notification)", () => {
    const policy = resumePolicyFor(new Error("bug applicatif"), 0);
    expect(policy).toEqual({ consumeRetry: true, delaySeconds: TRANSIENT_DELAY_SECONDS, notifyFailure: true });
  });
});

// ---------------------------------------------------------------------------
// Wrappers documents job
// ---------------------------------------------------------------------------

describe("wrappers documents job", () => {
  it("loadJobDoc délègue à resilientGet", async () => {
    resilientMocks.resilientGet.mockResolvedValueOnce({ id: "job-1" });
    const job = await loadJobDoc("videoRenderJobs", "job-1");
    expect(job).toEqual({ id: "job-1" });
    expect(resilientMocks.resilientGet).toHaveBeenCalledWith("videoRenderJobs", "job-1");
  });

  it("saveJobDoc délègue à resilientSet en merge avec owner", async () => {
    await saveJobDoc("videoRenderJobs", "job-1", { status: "queued" }, "user-1");
    expect(resilientMocks.resilientSet).toHaveBeenCalledWith(
      "videoRenderJobs",
      "job-1",
      { status: "queued" },
      { merge: true, ownerId: "user-1" },
    );
  });

  it("createJobDoc délègue à resilientCreate", async () => {
    const payload = { id: "job-1", status: "queued" };
    await createJobDoc("videoRenderJobs", "job-1", payload, "user-1");
    expect(resilientMocks.resilientCreate).toHaveBeenCalledWith("videoRenderJobs", "job-1", payload, "user-1");
  });

  it("queryJobDocs délègue à resilientQuery avec le filtre de payload", async () => {
    resilientMocks.resilientQuery.mockResolvedValueOnce([{ id: "job-1" }]);
    const jobs = await queryJobDocs("videoRenderJobs", "status", "queued", { orderField: "createdAt" });
    expect(jobs).toEqual([{ id: "job-1" }]);
    expect(resilientMocks.resilientQuery).toHaveBeenCalledWith(
      "videoRenderJobs",
      [{ field: "status", value: "queued" }],
      { orderField: "createdAt" },
    );
  });
});
