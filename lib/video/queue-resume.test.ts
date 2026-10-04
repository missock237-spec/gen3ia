import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests du module queue-resume (Task 95-c) — reprise quota-aware des files.
 *
 * Patterns : client Supabase factice chaînable (comme firestore-fallback.test.ts)
 * + couche résiliente mockée en vi.fn pour valider les wrappers, quota-guard
 * RÉEL pour la classification (reset entre tests).
 */

// ---------------------------------------------------------------------------
// État hoisted — client Supabase factice
// ---------------------------------------------------------------------------

type FakeRow = {
  collection: string;
  document_id: string;
  payload: Record<string, unknown>;
  updated_at?: string;
};

const supabaseState = vi.hoisted(() => ({
  configured: true,
  rows: [] as Array<{ collection: string; document_id: string; payload: Record<string, unknown>; updated_at?: string }>,
  ops: [] as Array<{ op: string; args?: unknown }>,
  readError: null as unknown,
  updateError: null as unknown,
  updateThrows: false,
}));

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => (supabaseState.configured ? supabaseFake() : null),
}));

/** `payload->>champ.is.null` / `payload->>champ.lt."valeur"` (ISO lexical). */
function evaluateOrClause(row: FakeRow, clause: string): boolean {
  return clause.split(",").some((condition) => {
    const match = /^payload->>(\w+)\.(is|lt)\.(.+)$/.exec(condition.trim());
    if (!match) return false;
    const [, field, op, rawValue] = match;
    const value = row.payload?.[field];
    if (op === "is") return rawValue === "null" && (value === undefined || value === null);
    if (op === "lt") {
      const expected = rawValue.replace(/^"/, "").replace(/"$/, "");
      return String(value ?? "") < expected;
    }
    return false;
  });
}

function supabaseFake() {
  function selectBuilder(columns: string) {
    const filters: Array<(row: FakeRow) => boolean> = [];
    const builder = {
      eq: (column: string, value: unknown) => {
        supabaseState.ops.push({ op: "eq", args: [column, value] });
        filters.push((row) => String(row[column as keyof FakeRow]) === String(value));
        return builder;
      },
      maybeSingle: async () => {
        supabaseState.ops.push({ op: "select", args: columns });
        if (supabaseState.readError) return { data: null, error: supabaseState.readError };
        const match = supabaseState.rows.find((row) => filters.every((fn) => fn(row)));
        return { data: match ? { payload: match.payload } : null, error: null };
      },
    };
    return builder;
  }

  function updateBuilder(values: Record<string, unknown>) {
    const filters: Array<(row: FakeRow) => boolean> = [];
    const builder = {
      eq: (column: string, value: unknown) => {
        supabaseState.ops.push({ op: "eq", args: [column, value] });
        filters.push((row) => String(row[column as keyof FakeRow]) === String(value));
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        supabaseState.ops.push({ op: "in", args: [column, values] });
        if (column.startsWith("payload->>")) {
          const field = column.slice("payload->>".length);
          filters.push((row) => values.map(String).includes(String(row.payload?.[field])));
        } else {
          filters.push((row) => values.includes(row[column as keyof FakeRow]));
        }
        return builder;
      },
      or: (clause: string) => {
        supabaseState.ops.push({ op: "or", args: clause });
        filters.push((row) => evaluateOrClause(row, clause));
        return builder;
      },
      select: async (columns: string) => {
        supabaseState.ops.push({ op: "update-select", args: { columns, values } });
        if (supabaseState.updateThrows) throw new Error("supabase injoignable");
        if (supabaseState.updateError) return { data: null, error: supabaseState.updateError };
        const matched = supabaseState.rows.filter((row) => filters.every((fn) => fn(row)));
        for (const row of matched) {
          row.payload = values.payload as Record<string, unknown>;
          row.updated_at = values.updated_at as string;
        }
        return { data: matched.map((row) => ({ payload: row.payload })), error: null };
      },
    };
    return builder;
  }

  return {
    from: (_table: string) => ({
      select: (columns: string) => selectBuilder(columns),
      update: (values: Record<string, unknown>) => updateBuilder(values),
    }),
  };
}

// ---------------------------------------------------------------------------
// État hoisted — couche résiliente mockée (wrappers) + logger capturé
// ---------------------------------------------------------------------------

const resilientMocks = vi.hoisted(() => ({
  resilientGet: vi.fn(),
  resilientSet: vi.fn(),
  resilientCreate: vi.fn(),
  resilientQuery: vi.fn(),
  reconcileFallbackToFirestore: vi.fn(),
}));

vi.mock("@/lib/db/firestore-fallback", () => resilientMocks);

const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: loggerWarn, info: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Sujet sous test
// ---------------------------------------------------------------------------

import {
  QUOTA_BACKOFF_CAP_SECONDS,
  QUOTA_BACKOFF_BASE_SECONDS,
  TRANSIENT_DELAY_SECONDS,
  claimJobViaFallback,
  classifyTickError,
  createJobDoc,
  loadJobDoc,
  maybeReconcileQuotaRecovery,
  queryJobDocs,
  resetQueueResumeForTests,
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
  supabaseState.configured = true;
  supabaseState.rows = [];
  supabaseState.ops = [];
  supabaseState.readError = null;
  supabaseState.updateError = null;
  supabaseState.updateThrows = false;
  vi.clearAllMocks();
  resetQueueResumeForTests();
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
// claimJobViaFallback
// ---------------------------------------------------------------------------

describe("claimJobViaFallback", () => {
  it("gagne le claim quand le bail est libre : payload fusionné retourné", async () => {
    const futureIso = new Date(Date.now() + 230_000).toISOString();
    supabaseState.rows = [
      { collection: "videoRenderJobs", document_id: "job-1", payload: { status: "queued", attempts: 2, progress: 0.4, userId: "user-1" } },
    ];
    const payload = await claimJobViaFallback(
      "videoRenderJobs",
      "job-1",
      { owner: "job-1:uuid-1", expiresAtIso: futureIso },
      ["queued", "processing"],
      { status: "processing", deadlineAt: futureIso },
    );
    expect(payload).not.toBeNull();
    // le payload retourné contient le bail + l'extraPatch + les champs courants
    expect(payload).toMatchObject({
      leaseOwner: "job-1:uuid-1",
      leaseExpiresAt: futureIso,
      status: "processing",
      deadlineAt: futureIso,
      attempts: 2,
      progress: 0.4,
      userId: "user-1",
    });
    // l'UPDATE porte bien le payload fusionné + updated_at
    const updateOp = supabaseState.ops.find((op) => op.op === "update-select");
    expect(updateOp).toBeDefined();
    const values = (updateOp!.args as { values: Record<string, unknown> }).values;
    expect(values.payload).toMatchObject({ leaseOwner: "job-1:uuid-1", status: "processing" });
    expect(typeof values.updated_at).toBe("string");
    // les 4 conditions chaînées sont présentes
    const ops = supabaseState.ops.map((op) => op.op);
    expect(ops.filter((op) => op === "eq").length).toBeGreaterThanOrEqual(2);
    expect(ops).toContain("or");
    expect(ops).toContain("in");
  });

  it("perd le claim quand le bail est encore vivant", async () => {
    const futureIso = new Date(Date.now() + 230_000).toISOString();
    supabaseState.rows = [
      {
        collection: "videoRenderJobs",
        document_id: "job-1",
        payload: { status: "processing", leaseOwner: "job-1:autre-worker", leaseExpiresAt: futureIso },
      },
    ];
    const payload = await claimJobViaFallback(
      "videoRenderJobs",
      "job-1",
      { owner: "job-1:uuid-2", expiresAtIso: new Date(Date.now() + 230_000).toISOString() },
      ["queued", "processing"],
      { status: "processing" },
    );
    expect(payload).toBeNull();
  });

  it("perd le claim quand le statut n'est pas réclamable (fil .in payload->>status)", async () => {
    supabaseState.rows = [
      { collection: "videoRenderJobs", document_id: "job-1", payload: { status: "completed" } },
    ];
    const payload = await claimJobViaFallback(
      "videoRenderJobs",
      "job-1",
      { owner: "job-1:uuid-3", expiresAtIso: new Date(Date.now() + 230_000).toISOString() },
      ["queued", "processing"],
      { status: "processing" },
    );
    expect(payload).toBeNull();
  });

  it("retourne null quand Supabase n'est pas configuré (aucun appel)", async () => {
    supabaseState.configured = false;
    const payload = await claimJobViaFallback(
      "videoRenderJobs",
      "job-1",
      { owner: "job-1:u", expiresAtIso: new Date().toISOString() },
      ["queued"],
      {},
    );
    expect(payload).toBeNull();
    expect(supabaseState.ops).toHaveLength(0);
  });

  it("retourne null sur erreur de lecture (warn pino, aucune levée)", async () => {
    supabaseState.rows = [{ collection: "c", document_id: "job-1", payload: { status: "queued" } }];
    supabaseState.readError = { message: "lecture impossible" };
    const payload = await claimJobViaFallback("c", "job-1", { owner: "j:u", expiresAtIso: new Date().toISOString() }, ["queued"], {});
    expect(payload).toBeNull();
    expect(loggerWarn).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1" }), "fallback_claim_failed");
  });

  it("retourne null sur erreur d'UPDATE (warn pino, aucune levée)", async () => {
    supabaseState.rows = [{ collection: "c", document_id: "job-1", payload: { status: "queued" } }];
    supabaseState.updateError = { message: "update impossible" };
    const payload = await claimJobViaFallback("c", "job-1", { owner: "j:u", expiresAtIso: new Date().toISOString() }, ["queued"], {});
    expect(payload).toBeNull();
    expect(loggerWarn).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1" }), "fallback_claim_failed");
  });

  it("retourne null si le client Supabase lève (exception attrapée, warn)", async () => {
    supabaseState.rows = [{ collection: "c", document_id: "job-1", payload: { status: "queued" } }];
    supabaseState.updateThrows = true;
    const payload = await claimJobViaFallback("c", "job-1", { owner: "j:u", expiresAtIso: new Date().toISOString() }, ["queued"], {});
    expect(payload).toBeNull();
    expect(loggerWarn).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1" }), "fallback_claim_failed");
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

// ---------------------------------------------------------------------------
// maybeReconcileQuotaRecovery
// ---------------------------------------------------------------------------

describe("maybeReconcileQuotaRecovery", () => {
  it("retourne le résultat de la passe puis se THROTTLE 5 min", async () => {
    resilientMocks.reconcileFallbackToFirestore.mockResolvedValueOnce({ reconciled: 3, failed: 0, skipped: false });
    const first = await maybeReconcileQuotaRecovery(25);
    expect(first).toEqual({ reconciled: 3, failed: 0, skipped: false });
    expect(resilientMocks.reconcileFallbackToFirestore).toHaveBeenCalledWith({ limit: 25 });
    const second = await maybeReconcileQuotaRecovery(25);
    expect(second).toBeNull();
    expect(resilientMocks.reconcileFallbackToFirestore).toHaveBeenCalledTimes(1);
  });

  it("resetQueueResumeForTests remet le throttle à zéro", async () => {
    resilientMocks.reconcileFallbackToFirestore.mockResolvedValue({ reconciled: 0, failed: 0, skipped: true });
    await maybeReconcileQuotaRecovery();
    resetQueueResumeForTests();
    const again = await maybeReconcileQuotaRecovery();
    expect(again).toEqual({ reconciled: 0, failed: 0, skipped: true });
    expect(resilientMocks.reconcileFallbackToFirestore).toHaveBeenCalledTimes(2);
  });

  it("ne lève JAMAIS (incident réconciliation → null)", async () => {
    resilientMocks.reconcileFallbackToFirestore.mockRejectedValueOnce(new Error("réconciliation impossible"));
    const result = await maybeReconcileQuotaRecovery(10);
    expect(result).toBeNull();
    expect(loggerWarn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }), "fallback_reconcile_failed");
  });
});
