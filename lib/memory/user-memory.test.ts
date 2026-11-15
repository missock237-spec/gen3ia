import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 109-c — mémoire conservatoire clé/valeur sur R2 (user-memory).
 *
 * Mock R2 EN MÉMOIRE (Map clé→Buffer, NoSuchKey sur absent) — même approche
 * que lib/identity/r2-identity-store.test.ts / workspace-durability.test.ts —
 * sur lequel on pose une implémentation IN-MÉMOIRE fidèle du CONTRAT
 * `lib/storage/user-data-store` (livré par 109-a) : clés canoniques
 * `users/{uid}/{...}.json`, ULID chronologique, JSON canonique, erreurs
 * classifiées (not_found/corrupted/too_large/unavailable/invalid).
 */

const r2State = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
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

  // ULID 26 chars Crockford base32, strictement croissant (compteur monotone
  // en partie aléatoire) : tri lexicographique = ordre chronologique.
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

import { forget, getMemoryEntry, listMemories, recall, remember } from "./user-memory";

const UID = "uid-mem-1";

function docBrut(key: string): Record<string, unknown> | undefined {
  const brut = r2State.store.get(`users/${UID}/memories/${key}.json`);
  return brut ? (JSON.parse(brut.toString("utf8")) as Record<string, unknown>) : undefined;
}

function cleSouvenir(i: number) {
  return `users/${UID}/memories/k${i}.json`;
}

beforeEach(() => {
  r2State.store.clear();
});

describe("remember — écriture idempotente et fusion", () => {
  it("crée le document au chemin canonique puis préserve createdAt à la réécriture", async () => {
    await remember({ userId: UID, key: "food", value: "végétarien" });
    const premier = docBrut("food");
    expect(premier).toMatchObject({
      v: 1,
      userId: UID,
      key: "food",
      value: "végétarien",
      source: "user",
    });
    expect(typeof premier?.createdAt).toBe("string");
    expect(typeof premier?.updatedAt).toBe("string");

    await new Promise((resolve) => setTimeout(resolve, 12));
    await remember({ userId: UID, key: "food", value: "végétarien" });

    // Un seul objet R2 pour la clé : l'écriture est un merge, pas un doublon.
    const cles = [...r2State.store.keys()].filter((key) => key.startsWith(`users/${UID}/memories/`));
    expect(cles).toEqual([`users/${UID}/memories/food.json`]);
    const second = docBrut("food");
    expect(second?.createdAt).toBe(premier?.createdAt);
    expect(second?.updatedAt).not.toBe(premier?.updatedAt);
  });

  it("encode le libellé comme segment d'objet (encodeURIComponent)", async () => {
    await remember({ userId: UID, key: "projet:alpha", value: "Gen3ia" });
    expect(r2State.store.has(`users/${UID}/memories/projet%3Aalpha.json`)).toBe(true);
  });

  it("hache les libellés dont l'encodage dépasse 200 caractères (borne 1024 octets R2)", async () => {
    // 100 chars CJK → encodeURIComponent ≈ 900 chars : dépasse le seuil, le
    // segment devient « h- » + SHA-256 hex (64 chars), déterministe.
    const longLabel = "踏".repeat(100);
    await remember({ userId: UID, key: longLabel, value: "Gen3ia" });
    const cleHash = [...r2State.store.keys()].find((k) => k.includes("/memories/h-"));
    expect(cleHash).toBeDefined();
    expect(cleHash).toBe(`users/${UID}/memories/h-${createHash("sha256").update(longLabel, "utf8").digest("hex")}.json`);
    // Le libellé d'origine voyage dans le document ; recall fonctionne.
    await expect(recall({ userId: UID, key: longLabel })).resolves.toBe("Gen3ia");
  });

  it("respecte la source explicite « agent »", async () => {
    await remember({ userId: UID, key: "tone", value: "factuel", source: "agent" });
    expect(docBrut("tone")?.source).toBe("agent");
  });

  it("rejette clé invalide, valeur à secret et userId vide (messages historiques)", async () => {
    await expect(remember({ userId: UID, key: "clé invalide !", value: "x" })).rejects.toThrow("Invalid memory key.");
    await expect(remember({ userId: UID, key: `${"a".repeat(161)}`, value: "x" })).rejects.toThrow("Invalid memory key.");
    await expect(remember({ userId: UID, key: "cle-ok", value: "sk-abcdefghijklmnopqrstuvwx" })).rejects.toThrow(
      "Memory rejected because it appears to contain credentials or secrets.",
    );
    await expect(remember({ userId: "  ", key: "cle-ok", value: "x" })).rejects.toThrow("Memory requires userId.");
    expect(r2State.store.size).toBe(0);
  });
});

describe("remember — limite de 200 souvenirs", () => {
  it("refuse le 201e souvenir avec le message FR historique", async () => {
    for (let i = 0; i < 200; i++) {
      await remember({ userId: UID, key: `k${i}`, value: `valeur ${i}` });
    }
    await expect(remember({ userId: UID, key: "debordement", value: "x" })).rejects.toThrow(
      "Limite de 200 souvenirs atteinte. Supprimez-en pour libérer de la place.",
    );
    expect(r2State.store.has(`users/${UID}/memories/debordement.json`)).toBe(false);
  });

  it("laisse mettre à jour une clé existante même à la limite", async () => {
    for (let i = 0; i < 200; i++) {
      await remember({ userId: UID, key: `k${i}`, value: `valeur ${i}` });
    }
    await expect(remember({ userId: UID, key: "k5", value: "valeur mise à jour" })).resolves.toBeUndefined();
    expect(docBrut("k5")?.value).toBe("valeur mise à jour");
  });

  it("libère la place après un forget", async () => {
    for (let i = 0; i < 200; i++) {
      await remember({ userId: UID, key: `k${i}`, value: `valeur ${i}` });
    }
    await forget(UID, "k0");
    await expect(remember({ userId: UID, key: "debordement", value: "x" })).resolves.toBeUndefined();
    expect(r2State.store.has(cleSouvenir(0))).toBe(false);
    expect(r2State.store.has(`users/${UID}/memories/debordement.json`)).toBe(true);
  });
});

describe("recall / getMemoryEntry — contrat anti-écrasement", () => {
  it("recall : null si absent, valeur si présente", async () => {
    await expect(recall({ userId: UID, key: "inconnue" })).resolves.toBeNull();
    await remember({ userId: UID, key: "food", value: "végétarien" });
    await expect(recall({ userId: UID, key: "food" })).resolves.toBe("végétarien");
  });

  it("getMemoryEntry : null si absent, forme contractuelle si présente", async () => {
    await expect(getMemoryEntry(UID, "inconnue")).resolves.toBeNull();
    await remember({ userId: UID, key: "food", value: "végétarien" });
    const entree = await getMemoryEntry(UID, "food");
    expect(entree).toEqual({
      key: "food",
      value: "végétarien",
      source: "user",
      updatedAt: expect.any(String),
    });
  });
});

describe("listMemories — tri updatedAt desc et plafond", () => {
  function poserDoc(key: string, updatedAt: string) {
    r2State.store.set(
      `users/uid-mem-2/memories/${key}.json`,
      Buffer.from(JSON.stringify({ v: 1, userId: "uid-mem-2", key, value: `valeur ${key}`, source: "user", createdAt: updatedAt, updatedAt })),
    );
  }

  it("trie par updatedAt desc et respecte la limite", async () => {
    poserDoc("a", "2026-01-01T10:00:00.000Z");
    poserDoc("b", "2026-02-01T10:00:00.000Z");
    poserDoc("c", "2026-03-01T10:00:00.000Z");

    expect((await listMemories("uid-mem-2", 2)).map((entry) => entry.key)).toEqual(["c", "b"]);
    expect((await listMemories("uid-mem-2")).map((entry) => entry.key)).toEqual(["c", "b", "a"]);
  });

  it("borne la limite : limit 0 est remonté à 1", async () => {
    poserDoc("a", "2026-01-01T10:00:00.000Z");
    poserDoc("b", "2026-02-01T10:00:00.000Z");
    const page = await listMemories("uid-mem-2", 0);
    expect(page).toHaveLength(1);
    expect(page[0]?.key).toBe("b");
  });
});

describe("forget — suppression idempotente", () => {
  it("supprime le souvenir et tolère les répétitions", async () => {
    await remember({ userId: UID, key: "food", value: "végétarien" });
    await forget(UID, "food");
    await expect(recall({ userId: UID, key: "food" })).resolves.toBeNull();
    await expect(forget(UID, "food")).resolves.toBeUndefined();
    expect(r2State.store.has(`users/${UID}/memories/food.json`)).toBe(false);
  });
});
