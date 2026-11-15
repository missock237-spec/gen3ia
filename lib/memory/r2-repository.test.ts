import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 109-c — mémoire épisodique sur R2 (lib/memory/repository).
 *
 * Mock R2 EN MÉMOIRE (Map clé→Buffer, NoSuchKey sur absent) + mini-
 * implémentation IN-MÉMOIRE du contrat `lib/storage/user-data-store`
 * (109-a) — même approche que lib/identity/r2-identity-store.test.ts.
 * Le miroir vectoriel Qdrant est simulé pour vérifier le fail-soft : un
 * index en panne ne fait JAMAIS échouer l'écriture R2.
 */

const r2State = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
}));

const vectorState = vi.hoisted(() => ({
  calls: [] as Array<{ collection: string; id: string; vector: number[]; payload: Record<string, unknown> }>,
  fail: false,
}));

vi.mock("@/lib/storage/r2", () => ({
  putObject: async (options: { key: string; body: Uint8Array | Buffer; contentType: string; contentLength?: number }) => {
    const body = Buffer.from(options.body);
    r2State.store.set(options.key, body);
  },
  downloadFromR2: async (key: string, maxBytes?: number) => {
    const body = r2State.store.get(key);
    if (!body) {
      // Forme réelle du SDK S3 v3 : name = "NoSuchKey" (+ metadata 404).
      const error = new Error("The specified key does not exist.");
      error.name = "NoSuchKey";
      (error as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 404 };
      throw error;
    }
    if (typeof maxBytes === "number" && body.byteLength > maxBytes) {
      throw new Error("R2 object exceeds configured read limit");
    }
    return body;
  },
  deleteFromR2: async (key: string) => {
    r2State.store.delete(key);
  },
  listObjectsUnderPrefix: async (prefix: string, maxResults?: number) => {
    return [...r2State.store.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, maxResults ?? 500)
      .map((key) => ({ key, sizeBytes: r2State.store.get(key)!.length, updatedAt: "" }));
  },
}));

vi.mock("@/lib/storage/user-data-store", () => {
  /* Mini-implémentation du contrat 109-a, posée SUR le mock R2 (couche
   * production identique : user-data-store → lib/storage/r2). */
  class UserDataError extends Error {
    code: "not_found" | "too_large" | "corrupted" | "unavailable" | "invalid";
    constructor(code: UserDataError["code"], message: string) {
      super(message);
      this.name = "UserDataError";
      this.code = code;
    }
  }

  const WRITE_MAX_BYTES = 256 * 1024;
  const READ_MAX_BYTES = 2 * WRITE_MAX_BYTES;
  const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
  // `%` toléré : segments produits par encodeURIComponent (clés mémoire canoniques).
  const SEGMENT_RE = /^[A-Za-z0-9._%-]{1,128}$/;

  function isNoSuchKey(error: unknown): boolean {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    return err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404;
  }

  function userKey(uid: string, ...segments: string[]): string {
    if (!UID_RE.test(uid)) throw new UserDataError("invalid", `uid invalide : ${uid}`);
    for (const segment of segments) {
      if (!SEGMENT_RE.test(segment) || segment.includes("..")) {
        throw new UserDataError("invalid", `segment de clé invalide : ${segment}`);
      }
    }
    return `users/${uid}/${segments.join("/")}.json`;
  }

  // ULID 26 chars Crockford base32, strictement croissant (compteur monotone).
  const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let ulidCounter = 0n;
  function newUlid(now?: Date): string {
    ulidCounter += 1n;
    let time = BigInt(Math.floor((now ?? new Date()).getTime()));
    let timeChars = "";
    for (let i = 0; i < 10; i++) {
      timeChars = CROCKFORD[Number(time % 32n)] + timeChars;
      time /= 32n;
    }
    let rand = ulidCounter;
    let randChars = "";
    for (let i = 0; i < 16; i++) {
      randChars = CROCKFORD[Number(rand % 32n)] + randChars;
      rand /= 32n;
    }
    return timeChars + randChars;
  }

  /** JSON canonique : clés triées récursivement (tableaux préservés). */
  function serialize(value: unknown): string {
    const sortKeys = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map(sortKeys);
      if (input !== null && typeof input === "object") {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(input as Record<string, unknown>).sort()) {
          sorted[key] = sortKeys((input as Record<string, unknown>)[key]);
        }
        return sorted;
      }
      return input;
    };
    return JSON.stringify(sortKeys(value));
  }

  async function readJson<T>(key: string, opts?: { maxBytes?: number }): Promise<T> {
    const r2 = await import("@/lib/storage/r2");
    try {
      const body = await r2.downloadFromR2(key, opts?.maxBytes ?? READ_MAX_BYTES);
      try {
        return JSON.parse(body.toString("utf8")) as T;
      } catch {
        throw new UserDataError("corrupted", `Document illisible : ${key}`);
      }
    } catch (error) {
      if (error instanceof UserDataError) throw error;
      if (isNoSuchKey(error)) throw new UserDataError("not_found", `Objet absent : ${key}`);
      if (error instanceof Error && error.message.includes("exceeds configured read limit")) {
        throw new UserDataError("too_large", `Objet trop grand : ${key}`);
      }
      throw new UserDataError("unavailable", `R2 indisponible : ${key}`);
    }
  }

  async function readJsonIfExists<T>(key: string, opts?: { maxBytes?: number }): Promise<T | null> {
    try {
      return await readJson<T>(key, opts);
    } catch (error) {
      if (error instanceof UserDataError && error.code === "not_found") return null;
      throw error;
    }
  }

  async function writeJson(key: string, value: unknown, opts?: { maxBytes?: number }): Promise<void> {
    const r2 = await import("@/lib/storage/r2");
    const body = Buffer.from(serialize(value), "utf8");
    if (body.byteLength > (opts?.maxBytes ?? WRITE_MAX_BYTES)) {
      throw new UserDataError("too_large", `Écriture trop grande : ${key}`);
    }
    await r2.putObject({ key, body, contentType: "application/json" });
  }

  async function patchJson<T>(key: string, patch: Partial<T>, opts?: { maxBytes?: number }): Promise<T> {
    const existing = await readJsonIfExists<Record<string, unknown>>(key, opts);
    const merged = { ...(existing ?? {}), ...(patch as Record<string, unknown>) } as T;
    await writeJson(key, merged, opts);
    return merged;
  }

  async function removeKey(key: string): Promise<void> {
    const r2 = await import("@/lib/storage/r2");
    try {
      await r2.deleteFromR2(key);
    } catch (error) {
      if (!isNoSuchKey(error)) throw error;
    }
  }

  async function listKeys(prefix: string, opts?: { maxObjects?: number }): Promise<Array<{ key: string; size: number; lastModified: string }>> {
    const r2 = await import("@/lib/storage/r2");
    const objects = await r2.listObjectsUnderPrefix(prefix, opts?.maxObjects ?? 500);
    return objects.map((object) => ({ key: object.key, size: object.sizeBytes, lastModified: object.updatedAt }));
  }

  async function removePrefix(prefix: string, opts?: { maxObjects?: number }): Promise<number> {
    const keys = await listKeys(prefix, { maxObjects: opts?.maxObjects ?? 1000 });
    for (const { key } of keys) await removeKey(key);
    return keys.length;
  }

  async function listJson<T>(prefix: string, opts?: { limit?: number; maxBytesPerDoc?: number; skipCorrupted?: boolean }): Promise<T[]> {
    const skipCorrupted = opts?.skipCorrupted ?? true;
    const keys = await listKeys(prefix, { maxObjects: 500 });
    const out: T[] = [];
    for (const { key } of keys) {
      if (typeof opts?.limit === "number" && out.length >= opts.limit) break;
      try {
        out.push(await readJson<T>(key, { maxBytes: opts?.maxBytesPerDoc }));
      } catch (error) {
        if (skipCorrupted && error instanceof UserDataError && (error.code === "corrupted" || error.code === "not_found")) continue;
        throw error;
      }
    }
    return out;
  }

  function isAbsence(error: unknown): boolean {
    return error instanceof UserDataError && error.code === "not_found";
  }

  return { UserDataError, userKey, newUlid, readJson, readJsonIfExists, writeJson, patchJson, removeKey, removePrefix, listKeys, listJson, isAbsence };
});

vi.mock("@/lib/memory/vector-store", () => ({
  VECTOR_COLLECTION_MEMORIES: "gen3ia_memories",
  upsertVectorPoints: async (
    collection: string,
    points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>,
  ) => {
    if (vectorState.fail) throw new Error("Qdrant indisponible (mock)");
    for (const point of points) {
      vectorState.calls.push({ collection, id: point.id, vector: point.vector, payload: point.payload });
    }
    return true;
  },
}));

import {
  getMemory,
  listAgentMemories,
  listProjectMemories,
  saveMemory,
} from "./repository";
import type { MemoryRecord } from "./types";

const UID = "uid-epi-1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

function souvenirepisodique(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "id-fourni-par-l-appelant",
    userId: UID,
    type: "conversation",
    content: "L'utilisateur préfère les réponses concises et factuelles.",
    metadata: { kind: "exchange" },
    importance: 0.5,
    createdAt: "2026-01-15T10:00:00.000Z",
    updatedAt: "2026-01-15T10:00:00.000Z",
    ...overrides,
  };
}

function docStocke(id: string): Record<string, unknown> {
  const brut = r2State.store.get(`users/${UID}/memory-items/${id}.json`);
  expect(brut).toBeDefined();
  return JSON.parse(brut!.toString("utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  r2State.store.clear();
  vectorState.calls.length = 0;
  vectorState.fail = false;
});

describe("saveMemory — persistance R2", () => {
  it("stocke l'item sous users/{uid}/memory-items/{ulid}.json et réassigne l'id en place", async () => {
    const memory = souvenirepisodique();
    await saveMemory(memory);

    // L'identifiant est un ULID (tri chronologique des clés) et l'objet passé
    // est mis à jour : writeMemory retourne l'identifiant réellement stocké.
    expect(memory.id).toMatch(ULID_RE);
    expect(memory.id).not.toBe("id-fourni-par-l-appelant");
    expect(r2State.store.has(`users/${UID}/memory-items/${memory.id}.json`)).toBe(true);

    const doc = docStocke(memory.id);
    expect(doc).toMatchObject({
      v: 1,
      id: memory.id,
      userId: UID,
      type: "conversation",
      content: "L'utilisateur préfère les réponses concises et factuelles.",
      metadata: { kind: "exchange" },
      importance: 0.5,
      createdAt: "2026-01-15T10:00:00.000Z",
    });
    expect(doc.embedding).toBeNull(); // embedding absent → null (forme historique)
    expect(typeof doc.updatedAt).toBe("string");
  });

  it("deux écritures dans la même milliseconde produisent des ULID distincts", async () => {
    const premiere = souvenirepisodique();
    const seconde = souvenirepisodique({ content: "Autre souvenir." });
    await saveMemory(premiere);
    await saveMemory(seconde);
    expect(premiere.id).not.toBe(seconde.id);
    expect(r2State.store.size).toBe(2);
  });

  it("conserve un embedding fourni tel quel", async () => {
    const memory = souvenirepisodique({ embedding: [0.1, 0.2, 0.3] });
    await saveMemory(memory);
    expect(docStocke(memory.id).embedding).toEqual([0.1, 0.2, 0.3]);
  });
});

describe("miroir vectoriel Qdrant — best-effort", () => {
  it("pousse un point UUID v5 avec aperçu court et memoryId réel", async () => {
    const memory = souvenirepisodique({ embedding: [0.1, 0.2, 0.3] });
    await saveMemory(memory);

    expect(vectorState.calls).toHaveLength(1);
    const call = vectorState.calls[0]!;
    expect(call.collection).toBe("gen3ia_memories");
    expect(call.id).toMatch(UUID_RE); // Qdrant exige un UUID (dérivé de l'ULID)
    expect(call.vector).toEqual([0.1, 0.2, 0.3]);
    expect(call.payload).toEqual({
      userId: UID,
      projectId: null,
      agentId: null,
      memoryId: memory.id,
      type: "conversation",
      preview: "L'utilisateur préfère les réponses concises et factuelles.",
    });
  });

  it("un miroir en échec ne fait PAS échouer l'écriture R2", async () => {
    vectorState.fail = true;
    const memory = souvenirepisodique({ embedding: [0.4, 0.5] });
    await expect(saveMemory(memory)).resolves.toBeUndefined();
    expect(docStocke(memory.id).content).toBe("L'utilisateur préfère les réponses concises et factuelles.");
  });

  it("pas d'embedding → aucun appel au miroir", async () => {
    await saveMemory(souvenirepisodique());
    expect(vectorState.calls).toHaveLength(0);
  });
});

describe("listAgentMemories / listProjectMemories — parcours filtrés", () => {
  it("filtre par agentId, trie createdAt desc et retire le tag interne v", async () => {
    await saveMemory(souvenirepisodique({ agentId: "agent-a", createdAt: "2026-01-01T00:00:00.000Z" }));
    await saveMemory(souvenirepisodique({ agentId: "agent-b", createdAt: "2026-01-02T00:00:00.000Z" }));
    await saveMemory(souvenirepisodique({ agentId: "agent-a", createdAt: "2026-01-03T00:00:00.000Z" }));

    const resultats = await listAgentMemories(UID, "agent-a", 200);
    expect(resultats).toHaveLength(2);
    expect(resultats.map((memory) => memory.createdAt)).toEqual([
      "2026-01-03T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
    for (const memory of resultats) {
      expect((memory as unknown as { v?: unknown }).v).toBeUndefined();
      expect(memory.agentId).toBe("agent-a");
    }
  });

  it("applique la limite après le tri", async () => {
    await saveMemory(souvenirepisodique({ agentId: "agent-a", createdAt: "2026-01-01T00:00:00.000Z" }));
    await saveMemory(souvenirepisodique({ agentId: "agent-a", createdAt: "2026-01-03T00:00:00.000Z" }));

    const page = await listAgentMemories(UID, "agent-a", 1);
    expect(page.map((memory) => memory.createdAt)).toEqual(["2026-01-03T00:00:00.000Z"]);
  });

  it("filtre par projectId et retourne [] pour un utilisateur sans souvenir", async () => {
    await saveMemory(souvenirepisodique({ projectId: "p1", createdAt: "2026-01-01T00:00:00.000Z" }));
    await saveMemory(souvenirepisodique({ projectId: "p2", createdAt: "2026-01-02T00:00:00.000Z" }));

    const projets = await listProjectMemories(UID, "p1", 100);
    expect(projets).toHaveLength(1);
    expect(projets[0]?.projectId).toBe("p1");

    await expect(listAgentMemories("uid-vide", "agent-a", 200)).resolves.toEqual([]);
  });
});

describe("getMemory — dégradation documentée R2", () => {
  it("retourne null sans userId (la clé R2 dépend du uid, repli parcours utilisateur)", async () => {
    const memory = souvenirepisodique({ embedding: [0.1] });
    await saveMemory(memory);
    await expect(getMemory(memory.id)).resolves.toBeNull();
  });
});
