import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 109-d — dépôt des runs (exécutions d'agents) sur backend R2.
 *
 * Mock R2 EN MÉMOIRE (Map clé → Buffer) — même approche que
 * lib/identity/r2-identity-store.test.ts / workspace-durability.test.ts :
 * le VRAI user-data-store (fondation 109-a) est exercé contre un R2 simulé
 * fidèle (NoSuchKey pour clé absente, listage par préfixe). Les anciens
 * mocks Firestore (Task 101 : index composite simulé) sont abandonnés —
 * sur R2, le préfixe `users/{uid}/runs/` EST l'index utilisateur.
 */

// ---------------------------------------------------------------------------
// État hoisted — R2 factice (Map clé → Buffer)
// ---------------------------------------------------------------------------

const r2State = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
  uploads: [] as string[],
  deletes: [] as string[],
  failUpload: false,
  failDownload: false,
  failDelete: false,
  failList: false,
}));

vi.mock("@/lib/storage/r2", () => {
  function notFound(key: string): Error {
    // Forme réelle du SDK S3 v3 : name = "NoSuchKey" (+ metadata 404).
    const error = new Error(`The specified key does not exist. (${key})`);
    error.name = "NoSuchKey";
    (error as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 404 };
    return error;
  }
  return {
    putObject: async (options: { key: string; body: Uint8Array | Buffer }) => {
      if (r2State.failUpload) throw new Error("R2 upload impossible (mock)");
      r2State.store.set(options.key, Buffer.from(options.body));
      r2State.uploads.push(options.key);
    },
    uploadToR2: async (key: string, body: Uint8Array | Buffer) => {
      if (r2State.failUpload) throw new Error("R2 upload impossible (mock)");
      r2State.store.set(key, Buffer.from(body));
      r2State.uploads.push(key);
    },
    downloadFromR2: async (key: string, maxBytes?: number) => {
      if (r2State.failDownload) throw new Error("R2 lecture impossible (mock)");
      const body = r2State.store.get(key);
      if (!body) throw notFound(key);
      if (typeof maxBytes === "number" && body.byteLength > maxBytes) {
        throw new Error("R2 object exceeds configured read limit");
      }
      return body;
    },
    deleteFromR2: async (key: string) => {
      if (r2State.failDelete) throw new Error("R2 suppression impossible (mock)");
      r2State.deletes.push(key);
      r2State.store.delete(key);
    },
    deleteObject: async (key: string) => {
      if (r2State.failDelete) throw new Error("R2 suppression impossible (mock)");
      r2State.deletes.push(key);
      r2State.store.delete(key);
    },
    listObjectsUnderPrefix: async (prefix: string, maxResults?: number) => {
      if (r2State.failList) throw new Error("R2 listage impossible (mock)");
      return [...r2State.store.keys()]
        .filter((key) => key.startsWith(prefix))
        .slice(0, maxResults ?? 500)
        .map((key) => ({ key, sizeBytes: r2State.store.get(key)!.length, updatedAt: "" }));
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import {
  createRun,
  deriveRunStatus,
  findRunByExecution,
  finalizeRun,
  getRun,
  getRunForConversation,
  listRecentRuns,
  listRunsForConversation,
  makeStep,
  updateRunByExecution,
  updateRunSteps,
} from "./repository";
import type { RunStep } from "@/lib/domain/conversations/types";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function step(index: number, status: RunStep["status"] = "done"): RunStep {
  return { id: `s${index}`, phase: "execution", title: `Étape ${index}`, status };
}

/** Sème un document run directement dans le R2 factice (createdAt maîtrisé). */
function seedRun(userId: string, runId: string, fields: Record<string, unknown> = {}): void {
  const doc = {
    v: 1,
    id: runId,
    userId,
    conversationId: "conv-1",
    objective: `Mission ${runId}`,
    status: "completed",
    steps: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...fields,
  };
  r2State.store.set(`users/${userId}/runs/${runId}.json`, Buffer.from(JSON.stringify(doc)));
}

function readDoc(key: string): Record<string, unknown> {
  const body = r2State.store.get(key);
  expect(body, `clé attendue dans R2 : ${key}`).toBeDefined();
  return JSON.parse(body!.toString("utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  r2State.store.clear();
  r2State.uploads.length = 0;
  r2State.deletes.length = 0;
  r2State.failUpload = false;
  r2State.failDownload = false;
  r2State.failDelete = false;
  r2State.failList = false;
});

// ---------------------------------------------------------------------------
// Primitifs purs
// ---------------------------------------------------------------------------

describe("makeStep — primitif pur (inchangé)", () => {
  it("construit une étape avec id, statut par défaut et troncatures", () => {
    const s = makeStep({ phase: "tools", title: "T".repeat(500), detail: "D".repeat(5000), toolName: "web.search" });
    expect(s.id).toHaveLength(36);
    expect(s.phase).toBe("tools");
    expect(s.title).toHaveLength(200);
    expect(s.detail).toHaveLength(4000);
    expect(s.status).toBe("pending");
    const explicit = makeStep({ phase: "plan", title: "Plan", status: "done" });
    expect(explicit.status).toBe("done");
  });
});

describe("deriveRunStatus — primitif pur (inchangé)", () => {
  it("dérive le statut depuis la timeline", () => {
    expect(deriveRunStatus([step(1, "awaiting")])).toBe("awaiting_approval");
    expect(deriveRunStatus([step(1, "pending")])).toBe("running");
    expect(deriveRunStatus([step(1, "in_progress")])).toBe("running");
    expect(deriveRunStatus([step(1, "failed")])).toBe("failed");
    expect(deriveRunStatus([step(1, "done")])).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Round-trip complet : create → get → update steps → finalize
// ---------------------------------------------------------------------------

describe("round-trip d'un run (create → find → update steps → finalize)", () => {
  it("createRun : doc écrit à users/{uid}/runs/{runId}.json, runId ULID, statut planning", async () => {
    const run = await createRun({
      userId: "user-1",
      conversationId: "conv-1",
      projectId: "proj-1",
      executionId: "exec-1",
      objective: "Rédiger un rapport mensuel",
      steps: [step(1)],
      runtime: { plan: { executionId: "exec-1" } },
    });
    expect(run.id).toMatch(ULID_RE);
    expect(run.status).toBe("planning");
    expect(run.objective).toBe("Rédiger un rapport mensuel");
    expect(Number.isNaN(Date.parse(run.createdAt))).toBe(false);

    const doc = readDoc(`users/user-1/runs/${run.id}.json`);
    expect(doc.v).toBe(1);
    expect(doc.id).toBe(run.id);
    expect(doc.userId).toBe("user-1");
    expect(doc.conversationId).toBe("conv-1");
    expect(doc.executionId).toBe("exec-1");
    expect(doc.status).toBe("planning");
  });

  it("getRun relit le run ; un autre utilisateur ne lit RIEN (cloisonnement par préfixe)", async () => {
    const created = await createRun({ userId: "user-1", conversationId: "conv-1", objective: "Objectif", steps: [step(1)] });
    const run = await getRun("user-1", created.id);
    expect(run?.objective).toBe("Objectif");
    expect(run?.steps).toHaveLength(1);
    expect(await getRun("user-2", created.id)).toBeNull();
    expect(await getRun("user-1", "inconnu")).toBeNull();
  });

  it("updateRunSteps puis finalizeRun : timeline et clôture persistées", async () => {
    const created = await createRun({ userId: "user-1", conversationId: "conv-1", objective: "Objectif", steps: [step(1, "pending")] });
    await updateRunSteps("user-1", created.id, [step(1, "done"), step(2, "in_progress")]);
    const enCours = await getRun("user-1", created.id);
    expect(enCours?.steps.map((s) => s.status)).toEqual(["done", "in_progress"]);
    expect(Date.parse(enCours!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(enCours!.createdAt));

    await finalizeRun("user-1", created.id, "completed", [step(1, "done"), step(2, "done")]);
    const final = await getRun("user-1", created.id);
    expect(final?.status).toBe("completed");
    expect(final?.finishedAt).toBeTruthy();
    expect(final?.steps).toHaveLength(2);
  });

  it("getRunForConversation : garde conversationId (fail-closed)", async () => {
    const created = await createRun({ userId: "user-1", conversationId: "conv-1", objective: "Objectif", steps: [] });
    expect((await getRunForConversation("user-1", created.id, "conv-1"))?.id).toBe(created.id);
    expect(await getRunForConversation("user-1", created.id, "conv-2")).toBeNull();
  });

  it("updateRunSteps sur un run absent : rejet not_found (sémantique .update() Firestore, pas de run fantôme)", async () => {
    await expect(updateRunSteps("user-1", "inconnu", [step(1)])).rejects.toMatchObject({
      name: "UserDataError",
      code: "not_found",
    });
    expect(r2State.store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findRunByExecution / updateRunByExecution
// ---------------------------------------------------------------------------

describe("findRunByExecution (scan préfixe + filtre + tri desc)", () => {
  it("renvoie le run LE PLUS RÉCENT lié à l'exécution ; inconnu → null", async () => {
    seedRun("user-1", "r-ancien", { executionId: "exec-1", createdAt: new Date("2026-01-01T00:00:00Z").toISOString() });
    seedRun("user-1", "r-recent", { executionId: "exec-1", createdAt: new Date("2026-01-03T00:00:00Z").toISOString() });
    seedRun("user-1", "r-autre", { executionId: "exec-2", createdAt: new Date("2026-01-02T00:00:00Z").toISOString() });

    const found = await findRunByExecution("user-1", "exec-1");
    expect(found?.id).toBe("r-recent");
    expect(await findRunByExecution("user-1", "exec-inconnu")).toBeNull();
    // Cloisonnement : les runs d'un autre utilisateur sont hors de portée.
    seedRun("user-2", "r-etranger", { executionId: "exec-1" });
    expect((await findRunByExecution("user-1", "exec-1"))?.id).toBe("r-recent");
  });
});

describe("updateRunByExecution (patch fail-soft)", () => {
  it("statut + steps + runtime appliqués ; finishedAt posé avec le statut final", async () => {
    seedRun("user-1", "r-1", { executionId: "exec-1", status: "running", steps: [step(1, "in_progress")] });
    const updated = await updateRunByExecution("user-1", "exec-1", {
      status: "completed",
      steps: [step(1, "done")],
      runtime: { finalText: "Livrable prêt." },
    });
    expect(updated?.status).toBe("completed");
    expect(updated?.steps).toEqual([step(1, "done")]);
    expect(updated?.runtime).toMatchObject({ finalText: "Livrable prêt." });

    const doc = readDoc("users/user-1/runs/r-1.json");
    expect(doc.status).toBe("completed");
    expect(doc.finishedAt).toBeTruthy();
    expect(doc.runtime).toMatchObject({ finalText: "Livrable prêt." });
  });

  it("run absent : null, aucune écriture (fils créés avant la fonctionnalité)", async () => {
    expect(await updateRunByExecution("user-1", "exec-inconnu", { status: "completed" })).toBeNull();
    expect(r2State.uploads).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Listes : conversations + missions récentes
// ---------------------------------------------------------------------------

describe("listRunsForConversation (filtre + tri desc + limit)", () => {
  it("filtre par conversation, trié createdAt desc, fenêtre limitée à 50", async () => {
    seedRun("user-1", "r-1", { conversationId: "conv-1", createdAt: new Date("2026-01-01T00:00:00Z").toISOString() });
    seedRun("user-1", "r-2", { conversationId: "conv-2", createdAt: new Date("2026-01-02T00:00:00Z").toISOString() });
    seedRun("user-1", "r-3", { conversationId: "conv-1", createdAt: new Date("2026-01-03T00:00:00Z").toISOString() });
    seedRun("user-2", "r-4", { conversationId: "conv-1", createdAt: new Date("2026-01-04T00:00:00Z").toISOString() });

    const runs = await listRunsForConversation("user-1", "conv-1");
    expect(runs.map((r) => r.id)).toEqual(["r-3", "r-1"]);
    expect(await listRunsForConversation("user-1", "conv-1", 1)).toEqual([runs[0]]);
  });
});

describe("listRecentRuns (fenêtre missions récentes)", () => {
  it("renvoie les 8 plus récents, triés createdAt desc, toutes conversations confondues", async () => {
    for (let i = 0; i < 30; i += 1) {
      seedRun("user-1", `r-${String(i).padStart(2, "0")}`, {
        objective: `Mission ${i + 1}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      });
    }
    const runs = await listRecentRuns("user-1");
    expect(runs).toHaveLength(8);
    expect(runs[0]!.objective).toBe("Mission 30");
    expect(runs[7]!.objective).toBe("Mission 23");
  });

  it("limit demandé borné à 20 ; aucun run → liste vide", async () => {
    for (let i = 0; i < 25; i += 1) {
      seedRun("user-1", `r-${String(i).padStart(2, "0")}`, {
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      });
    }
    expect(await listRecentRuns("user-1", 50)).toHaveLength(20);
    expect(await listRecentRuns("user-2")).toEqual([]);
  });
});
