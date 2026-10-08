import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 109-a — COUCHE FONDATION du magasin documentaire utilisateur R2.
 *
 * Mock R2 EN MÉMOIRE (Map) — même approche que lib/identity/r2-identity-
 * store.test.ts et lib/execution/workspace-durability.test.ts : on teste le
 * vrai store contre un R2 simulé fidèle (NoSuchKey pour clé absente avec
 * $metadata 404, plafond de lecture avec le message réel de lib/storage/r2,
 * listage par préfixe en ordre lexicographique comme ListObjectsV2).
 */

const r2State = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
  uploads: [] as Array<{ key: string; contentType: string; bytes: number }>,
  downloads: [] as string[],
  failUpload: false,
  failDownload: false,
  failDelete: false,
  /** DeleteObject qui remonte une absence (NoSuchKey) — removeKey doit tolérer. */
  failDeleteNoSuchKey: false,
  failList: false,
  /** Clés qui « disparaissent » entre le listage et la lecture (course). */
  vanishAtRead: new Set<string>(),
}));

function erreurAbsence(message = "The specified key does not exist."): Error {
  // Forme réelle du SDK S3 v3 : name = "NoSuchKey" (+ métadonnées 404).
  const error = new Error(message);
  error.name = "NoSuchKey";
  (error as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 404 };
  return error;
}

vi.mock("@/lib/storage/r2", () => ({
  putObject: async (options: { key: string; body: Uint8Array | Buffer; contentType: string; contentLength?: number }) => {
    if (r2State.failUpload) throw new Error("R2 upload impossible (mock)");
    const body = Buffer.from(options.body);
    r2State.store.set(options.key, body);
    r2State.uploads.push({ key: options.key, contentType: options.contentType, bytes: body.byteLength });
  },
  downloadFromR2: async (key: string, maxBytes?: number) => {
    r2State.downloads.push(key);
    if (r2State.failDownload) throw new Error("R2 lecture impossible (mock)");
    if (r2State.vanishAtRead.has(key) || !r2State.store.has(key)) throw erreurAbsence();
    const body = r2State.store.get(key)!;
    if (typeof maxBytes === "number" && body.byteLength > maxBytes) {
      // Message exact de lib/storage/r2.ts — reconnu par le store (too_large).
      throw new Error("R2 object exceeds configured read limit");
    }
    return body;
  },
  deleteObject: async (key: string) => {
    if (r2State.failDeleteNoSuchKey) throw erreurAbsence();
    if (r2State.failDelete) throw new Error("R2 suppression impossible (mock)");
    r2State.store.delete(key);
  },
  // deleteFromR2 : l'identity-store (importé pour assertValidUid/estAbsenceR2)
  // référence ce nom — le mock doit couvrir tout l'espace d'export utilisé.
  deleteFromR2: async (key: string) => {
    if (r2State.failDelete) throw new Error("R2 suppression impossible (mock)");
    r2State.store.delete(key);
  },
  listObjectsUnderPrefix: async (prefix: string, maxResults?: number) => {
    if (r2State.failList) throw new Error("R2 listage impossible (mock)");
    return [...r2State.store.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort() // ListObjectsV2 renvoie les clés dans l'ordre lexicographique.
      .slice(0, maxResults ?? 500)
      .map((key) => ({
        key,
        sizeBytes: r2State.store.get(key)!.length,
        updatedAt: "2025-06-01T12:00:00.000Z",
      }));
  },
}));

import {
  USER_DATA_DEFAULT_WRITE_CAP_BYTES,
  UserDataError,
  isAbsence,
  listJson,
  listKeys,
  newUlid,
  patchJson,
  readCapFor,
  readJson,
  readJsonIfExists,
  removeKey,
  removePrefix,
  userDir,
  userKey,
  writeJson,
} from "./user-data-store";

/** Alphabet Crockford base32 (même que le store) pour décoder les ULID. */
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

/** Décode les 10 caractères d'horodatage d'un ULID en millisecondes. */
function decodeHorodatage(ulid: string): number {
  let valeur = 0;
  for (const caractere of ulid.slice(0, 10)) {
    valeur = valeur * 32 + ULID_ALPHABET.indexOf(caractere);
  }
  return valeur;
}

/** Asserte qu'une action synchrone lève UserDataError avec le code attendu. */
function expecteCode(action: () => unknown, code: UserDataError["code"]): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(UserDataError);
    expect((error as UserDataError).code).toBe(code);
    return;
  }
  expect.unreachable("La validation aurait dû lever UserDataError.");
}

beforeEach(() => {
  r2State.store.clear();
  r2State.uploads.length = 0;
  r2State.downloads.length = 0;
  r2State.failUpload = false;
  r2State.failDownload = false;
  r2State.failDelete = false;
  r2State.failDeleteNoSuchKey = false;
  r2State.failList = false;
  r2State.vanishAtRead.clear();
});

describe("userDir / userKey — composition et validation", () => {
  it("userDir compose users/{uid}/{segments.join('/')}", () => {
    expect(userDir("uid-1", "conversations")).toBe("users/uid-1/conversations");
    expect(userDir("uid-1", "conversations", "abc", "messages")).toBe(
      "users/uid-1/conversations/abc/messages",
    );
    // Sans segment : préfixe de scan canonique (le join vide laisse le / final).
    expect(userDir("uid-1")).toBe("users/uid-1/");
  });

  it("userKey ajoute .json au dernier segment, sans double suffixe", () => {
    expect(userKey("uid-1", "conversations", "abc")).toBe("users/uid-1/conversations/abc.json");
    expect(userKey("uid-1", "agents", "a1.json")).toBe("users/uid-1/agents/a1.json");
  });

  it("userKey sans segment → UserDataError invalid (users/{uid}.json hors schéma)", () => {
    expecteCode(() => userKey("uid-1"), "invalid");
  });

  it("uid hostile → UserDataError invalid, AUCUNE clé jamais composée", () => {
    const hostiles = ["../x", "a/b", "", "a b", "uid$.json", "u".repeat(129), "."];
    for (const uid of hostiles) {
      expecteCode(() => userDir(uid, "conversations"), "invalid");
      expecteCode(() => userKey(uid, "conversations", "abc"), "invalid");
    }
    // Le stockage est resté vierge : aucun uid hostile n'a été transformé en clé.
    expect(r2State.store.size).toBe(0);
    expect(r2State.uploads).toHaveLength(0);
  });

  it("segments hostiles refusés — traversée d'espace de clés impossible", () => {
    // `%` nu, `%2` (hex incomplet) et `%G1` (hex invalide) sont refusés : seules
    // les séquences d'échappement %XX complètes (sortie encodeURIComponent) passent.
    const hostiles = ["..", ".", "", "a/b", "a b", "a".repeat(513), "é", "%", "%2", "%G1", "%%%"];
    for (const segment of hostiles) {
      expecteCode(() => userDir("uid-1", "conversations", segment), "invalid");
    }
    expect(r2State.store.size).toBe(0);
  });

  it("segments limites acceptés : 128 caractères, point/underscore/tiret", () => {
    const segment = "a".repeat(128);
    expect(userDir("uid-1", "v1.2_beta-final", segment)).toBe(
      `users/uid-1/v1.2_beta-final/${segment}`,
    );
    // Séquences %XX valides (encodeURIComponent) acceptées — clés mémoire canoniques.
    expect(userDir("uid-1", "memories", "projet%3Aalpha")).toBe("users/uid-1/memories/projet%3Aalpha");
    expect(userDir("uid-1", "memories", "%C3%A9")).toBe("users/uid-1/memories/%C3%A9");
  });
});

describe("newUlid — ULID Crockford 26 caractères", () => {
  it("format : 26 caractères, alphabet Crockford, horodatage décodable", () => {
    const date = new Date("2025-06-01T12:00:00.000Z");
    const ulid = newUlid(date);
    expect(ulid).toMatch(ULID_PATTERN);
    expect(ulid).toHaveLength(26);
    expect(decodeHorodatage(ulid)).toBe(date.getTime());
  });

  it("ordre lexicographique = ordre chronologique", () => {
    const dates = [
      new Date(Date.UTC(2020, 0, 1)),
      new Date(Date.UTC(2021, 5, 15)),
      new Date(), // maintenant — postérieur aux deux précédentes
    ];
    const ulids = dates.map((date) => newUlid(date));
    expect([...ulids].sort()).toEqual(ulids);
    ulids.forEach((ulid, index) => expect(decodeHorodatage(ulid)).toBe(dates[index]!.getTime()));
  });

  it("monotonie à la même milliseconde : compteur incrémenté, jamais de doublon d'ordre", () => {
    const date = new Date(Date.UTC(2025, 0, 2, 3, 4, 5));
    const ulids = [newUlid(date), newUlid(date), newUlid(date), newUlid(date), newUlid(date)];
    for (const ulid of ulids) {
      expect(ulid).toMatch(ULID_PATTERN);
      expect(decodeHorodatage(ulid)).toBe(date.getTime());
    }
    // Strictement croissant : le tri lexicographique reste l'ordre d'émission.
    const trie = [...ulids].sort();
    expect(trie).toEqual(ulids);
    expect(new Set(ulids).size).toBe(ulids.length);
  });

  it("sans argument : horodatage proche de maintenant", () => {
    const avant = Date.now();
    const ulid = newUlid();
    const apres = Date.now();
    const ms = decodeHorodatage(ulid);
    expect(ms).toBeGreaterThanOrEqual(avant);
    expect(ms).toBeLessThanOrEqual(apres);
  });
});

describe("plafonds par défaut", () => {
  it("écriture 256 Ko, lecture 2× (readCapFor)", () => {
    expect(USER_DATA_DEFAULT_WRITE_CAP_BYTES).toBe(256 * 1024);
    expect(readCapFor(USER_DATA_DEFAULT_WRITE_CAP_BYTES)).toBe(512 * 1024);
    expect(readCapFor(100)).toBe(200);
  });
});

describe("writeJson / readJson — aller-retour", () => {
  it("round-trip + sérialisation canonique (clés triées récursivement) + contentType", async () => {
    const key = userKey("uid-1", "memories", "profil");
    const doc = { b: 2, a: { d: 4, c: [3, 1] }, liste: [{ y: 2, x: 1 }], z: null };
    await writeJson(key, doc);

    expect(r2State.uploads).toHaveLength(1);
    expect(r2State.uploads[0]!.key).toBe("users/uid-1/memories/profil.json");
    expect(r2State.uploads[0]!.contentType).toBe("application/json");

    const brut = r2State.store.get(key)!.toString("utf8");
    const parse = JSON.parse(brut) as Record<string, unknown>;
    expect(Object.keys(parse)).toEqual([...Object.keys(parse)].sort());
    const imbrique = parse.a as Record<string, unknown>;
    expect(Object.keys(imbrique)).toEqual(["c", "d"]);
    const elementListe = (parse.liste as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(elementListe)).toEqual(["x", "y"]);

    await expect(readJson<typeof doc>(key)).resolves.toEqual(doc);
  });

  it("forme canonique STABLE : réécrire la même valeur produit des octets identiques", async () => {
    const key = userKey("uid-1", "runs", "r1");
    const doc = { nom: "run", meta: { z: 1, a: 2 }, etapes: [{ b: 1, a: 2 }] };
    await writeJson(key, doc);
    const premier = r2State.store.get(key)!.toString("utf8");
    await writeJson(key, doc);
    const second = r2State.store.get(key)!.toString("utf8");
    expect(second).toBe(premier);
  });

  it("la réécriture remplace le document (pas de duplication d'objet)", async () => {
    const key = userKey("uid-1", "conversations", "c1");
    await writeJson(key, { titre: "v1" });
    await writeJson(key, { titre: "v2" });
    expect(r2State.uploads.filter((entree) => entree.key === key)).toHaveLength(2);
    expect(r2State.store.size).toBe(1);
    await expect(readJson<{ titre: string }>(key)).resolves.toEqual({ titre: "v2" });
  });

  it("plafond d'écriture par défaut : exactement 256 Ko passe, +1 octet → too_large (rien écrit)", async () => {
    const key = userKey("uid-1", "notes", "gros");
    const remplissage = "x".repeat(USER_DATA_DEFAULT_WRITE_CAP_BYTES - 8); // {"a":"…"} = N+8 octets
    await writeJson(key, { a: remplissage });
    expect(r2State.uploads).toHaveLength(1);
    expect(r2State.uploads[0]!.bytes).toBe(USER_DATA_DEFAULT_WRITE_CAP_BYTES);

    r2State.uploads.length = 0;
    await expect(
      writeJson(userKey("uid-1", "notes", "trop-gros"), { a: `${remplissage}x` }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(r2State.uploads).toHaveLength(0); // rien n'a été écrit
  });

  it("plafond personnalisé (opts.maxBytes) appliqué à l'écriture", async () => {
    await expect(
      writeJson(userKey("uid-1", "notes", "n1"), { a: "x".repeat(100) }, { maxBytes: 10 }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(r2State.store.size).toBe(0);
  });

  it("valeur undefined → UserDataError invalid (jamais de TypeError brute)", async () => {
    await expect(
      writeJson(userKey("uid-1", "notes", "n1"), undefined),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("plafond de lecture par défaut = 2× cap d'écriture : 512 Ko passe la porte, +1 → too_large", async () => {
    const key = userKey("uid-1", "notes", "l1");
    r2State.store.set(key, Buffer.alloc(512 * 1024, 0x20));
    // Passe le plafond de lecture (égalité tolérée) puis échoue au parse → corrupted.
    await expect(readJson(key)).rejects.toMatchObject({ code: "corrupted" });

    r2State.store.set(key, Buffer.alloc(512 * 1024 + 1, 0x20));
    await expect(readJson(key)).rejects.toMatchObject({ code: "too_large" });
  });

  it("readJson avec plafond invalide (0, NaN) → UserDataError invalid", async () => {
    const key = userKey("uid-1", "notes", "n1");
    await expect(readJson(key, { maxBytes: 0 })).rejects.toMatchObject({ code: "invalid" });
    await expect(readJson(key, { maxBytes: Number.NaN })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("absence / corruption / indisponibilité — classification des erreurs", () => {
  it("clé absente → readJson not_found ; readJsonIfExists → null", async () => {
    const key = userKey("uid-1", "conversations", "absent");
    await expect(readJson(key)).rejects.toMatchObject({
      name: "UserDataError",
      code: "not_found",
    });
    await expect(readJsonIfExists(key)).resolves.toBeNull();
  });

  it("JSON corrompu → readJson corrupted ; readJsonIfExists PROPAGE (jamais confondu avec absent)", async () => {
    const key = userKey("uid-1", "conversations", "corrompu");
    r2State.store.set(key, Buffer.from("{ pas du json"));
    await expect(readJson(key)).rejects.toMatchObject({ code: "corrupted" });
    await expect(readJsonIfExists(key)).rejects.toMatchObject({ code: "corrupted" });
  });

  it("panne R2 en lecture → unavailable (readJson ET readJsonIfExists propagent)", async () => {
    r2State.failDownload = true;
    const key = userKey("uid-1", "conversations", "c1");
    await expect(readJson(key)).rejects.toMatchObject({ code: "unavailable" });
    await expect(readJsonIfExists(key)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("panne R2 en écriture → UserDataError unavailable", async () => {
    r2State.failUpload = true;
    await expect(writeJson(userKey("uid-1", "notes", "n1"), { a: 1 })).rejects.toMatchObject({
      name: "UserDataError",
      code: "unavailable",
    });
  });

  it("isAbsence réexporte la sémantique estAbsenceR2", () => {
    expect(isAbsence(erreurAbsence())).toBe(true);
    const parCode = new Error("x");
    (parCode as unknown as { code: string }).code = "NoSuchKey";
    expect(isAbsence(parCode)).toBe(true);
    expect(isAbsence(new Error("NoSuchKey (mock)"))).toBe(true);
    expect(isAbsence(new UserDataError("not_found", "absent"))).toBe(false);
    expect(isAbsence(new Error("panne réseau"))).toBe(false);
    expect(isAbsence(null)).toBe(false);
  });
});

describe("patchJson — read-merge-write", () => {
  it("document absent → création { v: 1, ...patch }", async () => {
    const key = userKey("uid-1", "conversations", "c1");
    const fusion = await patchJson<{ titre: string; v: number }>(key, { titre: "Nouvelle" });
    expect(fusion).toEqual({ v: 1, titre: "Nouvelle" });
    // Le document fusionné est bien celui stocké.
    await expect(readJson<{ v: number; titre: string }>(key)).resolves.toEqual(fusion);
  });

  it("document existant → fusion SHALLOW (le patch remplace les champs de premier niveau)", async () => {
    const key = userKey("uid-1", "conversations", "c1");
    await writeJson(key, { v: 1, titre: "Ancien", meta: { x: 1, y: 2 } });
    const fusion = await patchJson<{ titre: string; meta: Record<string, number> }>(key, {
      titre: "Nouveau",
      meta: { z: 3 },
    });
    expect(fusion).toEqual({ v: 1, titre: "Nouveau", meta: { z: 3 } }); // meta remplacé, pas fusionné
    await expect(readJson(key)).resolves.toEqual(fusion);
  });

  it("document existant non objet JSON (tableau) → corrupted, rien écrit", async () => {
    const key = userKey("uid-1", "notes", "tableau");
    r2State.store.set(key, Buffer.from("[1,2,3]"));
    await expect(patchJson(key, { a: 1 })).rejects.toMatchObject({ code: "corrupted" });
    expect(r2State.uploads).toHaveLength(0);
  });

  it("panne R2 à la lecture du patch → unavailable propagé", async () => {
    r2State.failDownload = true;
    await expect(patchJson(userKey("uid-1", "notes", "n1"), { a: 1 })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(r2State.uploads).toHaveLength(0);
  });
});

describe("removeKey — idempotence", () => {
  it("supprime une clé existante", async () => {
    const key = userKey("uid-1", "memories", "m1");
    await writeJson(key, { contenu: "x" });
    await removeKey(key);
    await expect(readJsonIfExists(key)).resolves.toBeNull();
  });

  it("clé déjà absente → succès (idempotent)", async () => {
    await expect(removeKey(userKey("uid-1", "memories", "absent"))).resolves.toBeUndefined();
  });

  it("DeleteObject qui remonte NoSuchKey → toléré (succès)", async () => {
    const key = userKey("uid-1", "memories", "m1");
    await writeJson(key, { contenu: "x" });
    r2State.failDeleteNoSuchKey = true;
    await expect(removeKey(key)).resolves.toBeUndefined();
  });

  it("autre panne R2 → UserDataError unavailable", async () => {
    r2State.failDelete = true;
    await expect(removeKey(userKey("uid-1", "memories", "m1"))).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});

describe("removePrefix — purge RGPD", () => {
  async function seed(racine: string, nombre: number): Promise<void> {
    for (let index = 0; index < nombre; index += 1) {
      r2State.store.set(`${racine}${String(index).padStart(3, "0")}.json`, Buffer.from("{}"));
    }
  }

  it("purge complète sous le préfixe, compte exact, n'affecte pas le reste", async () => {
    await seed("users/uid-1/conversations/", 25);
    await seed("users/uid-2/conversations/", 3);
    const supprimes = await removePrefix("users/uid-1/conversations/");
    expect(supprimes).toBe(25);
    expect([...r2State.store.keys()].filter((key) => key.startsWith("users/uid-1/"))).toHaveLength(0);
    expect([...r2State.store.keys()].filter((key) => key.startsWith("users/uid-2/"))).toHaveLength(3);
  });

  it("cap maxObjects : la purge s'arrête au cap (retentable)", async () => {
    await seed("users/uid-1/runs/", 25);
    const supprimes = await removePrefix("users/uid-1/runs/", { maxObjects: 10 });
    expect(supprimes).toBe(10);
    expect([...r2State.store.keys()].filter((key) => key.startsWith("users/uid-1/runs/"))).toHaveLength(15);
  });

  it("défaut à 1000 (au-delà du défaut 500 du listage brut)", async () => {
    await seed("users/uid-1/items/", 501);
    const supprimes = await removePrefix("users/uid-1/items/");
    expect(supprimes).toBe(501);
  });

  it("préfixe sans objet → 0", async () => {
    await expect(removePrefix("users/uid-vide/")).resolves.toBe(0);
  });

  it("panne au listage → unavailable", async () => {
    r2State.failList = true;
    await expect(removePrefix("users/uid-1/")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("panne à la suppression d'un lot → unavailable propagé", async () => {
    await seed("users/uid-1/runs/", 12);
    r2State.failDelete = true;
    await expect(removePrefix("users/uid-1/runs/")).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("listKeys — mapping et bornes", () => {
  it("mapping sizeBytes→size, updatedAt→lastModified, filtre par préfixe", async () => {
    await writeJson(userKey("uid-1", "agents", "a1"), { nom: "alpha" });
    await writeJson(userKey("uid-1", "agents", "a2"), { nom: "beta" });
    await writeJson(userKey("uid-2", "agents", "a3"), { nom: "gamma" });

    const entrees = await listKeys("users/uid-1/agents/");
    expect(entrees.map((entree) => entree.key)).toEqual([
      "users/uid-1/agents/a1.json",
      "users/uid-1/agents/a2.json",
    ]);
    expect(entrees[0]!.size).toBe(r2State.store.get("users/uid-1/agents/a1.json")!.length);
    expect(entrees[0]!.lastModified).toBe("2025-06-01T12:00:00.000Z");
  });

  it("cap maxObjects appliqué au listage", async () => {
    await seed3();
    const entrees = await listKeys("users/uid-1/agents/", { maxObjects: 2 });
    expect(entrees).toHaveLength(2);
  });

  it("préfixe sans objet → tableau vide", async () => {
    await expect(listKeys("users/uid-vide/")).resolves.toEqual([]);
  });

  it("panne R2 au listage → UserDataError unavailable", async () => {
    r2State.failList = true;
    await expect(listKeys("users/uid-1/")).rejects.toMatchObject({ code: "unavailable" });
  });

  async function seed3(): Promise<void> {
    for (const id of ["a1", "a2", "a3"]) {
      await writeJson(userKey("uid-1", "agents", id), { nom: id });
    }
  }
});

describe("listJson — scan de documents JSON", () => {
  it("lit tous les documents sous le préfixe, dans l'ordre lexicographique des clés", async () => {
    for (const [id, valeur] of [["03", "c"], ["01", "a"], ["02", "b"]] as const) {
      await writeJson(userKey("uid-1", "memory-items", id), { valeur });
    }
    const documents = await listJson<{ valeur: string }>("users/uid-1/memory-items/");
    expect(documents).toEqual([{ valeur: "a" }, { valeur: "b" }, { valeur: "c" }]);
  });

  it("s'arrête à limit : lecture tronquée au reste nécessaire du lot", async () => {
    for (let index = 0; index < 7; index += 1) {
      await writeJson(userKey("uid-1", "memory-items", `0${index}`), { index });
    }
    const documents = await listJson<{ index: number }>("users/uid-1/memory-items/", { limit: 3 });
    expect(documents).toHaveLength(3);
    expect(documents.map((document) => document.index)).toEqual([0, 1, 2]);
    // Seulement 3 lectures : le lot est tronqué, pas de lecture superflue.
    expect(r2State.downloads).toHaveLength(3);
  });

  it("limit atteint malgré un document corrompu intercalé (le scan continue)", async () => {
    await writeJson(userKey("uid-1", "memory-items", "00"), { index: 0 });
    r2State.store.set("users/uid-1/memory-items/01.json", Buffer.from("{ cassé"));
    await writeJson(userKey("uid-1", "memory-items", "02"), { index: 2 });
    await writeJson(userKey("uid-1", "memory-items", "03"), { index: 3 });

    const documents = await listJson<{ index: number }>("users/uid-1/memory-items/", { limit: 3 });
    expect(documents.map((document) => document.index)).toEqual([0, 2, 3]);
    expect(r2State.downloads).toHaveLength(4); // 3 du lot 1 (dont le corrompu) + 1 du lot 2
  });

  it("skipCorrupted (défaut) : documents corrompus ET trop grands ignorés", async () => {
    await writeJson(userKey("uid-1", "memory-items", "00"), { index: 0 });
    r2State.store.set("users/uid-1/memory-items/01.json", Buffer.from("{ cassé"));
    r2State.store.set(
      "users/uid-1/memory-items/02.json",
      Buffer.from(JSON.stringify({ a: "x".repeat(600 * 1024) })),
    );
    await writeJson(userKey("uid-1", "memory-items", "03"), { index: 3 });

    const documents = await listJson<{ index: number }>("users/uid-1/memory-items/");
    expect(documents).toEqual([{ index: 0 }, { index: 3 }]);
  });

  it("skipCorrupted=false → corrupted propage", async () => {
    await writeJson(userKey("uid-1", "memory-items", "00"), { index: 0 });
    r2State.store.set("users/uid-1/memory-items/01.json", Buffer.from("{ cassé"));
    await expect(
      listJson("users/uid-1/memory-items/", { skipCorrupted: false }),
    ).rejects.toMatchObject({ code: "corrupted" });
  });

  it("skipCorrupted=false → too_large propage", async () => {
    r2State.store.set(
      "users/uid-1/memory-items/00.json",
      Buffer.from(JSON.stringify({ a: "x".repeat(600 * 1024) })),
    );
    await expect(
      listJson("users/uid-1/memory-items/", { skipCorrupted: false }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("les clés non .json sont exclues du scan (jamais lues)", async () => {
    await writeJson(userKey("uid-1", "memory-items", "00"), { index: 0 });
    r2State.store.set("users/uid-1/memory-items/notes.txt", Buffer.from("binaire"));
    const documents = await listJson("users/uid-1/memory-items/");
    expect(documents).toEqual([{ index: 0 }]);
    expect(r2State.downloads).toEqual(["users/uid-1/memory-items/00.json"]);
  });

  it("limit 0 → aucun document, aucune lecture", async () => {
    await writeJson(userKey("uid-1", "memory-items", "00"), { index: 0 });
    await expect(listJson("users/uid-1/memory-items/", { limit: 0 })).resolves.toEqual([]);
    expect(r2State.downloads).toHaveLength(0);
  });

  it("document disparu entre listage et lecture (course) → simplement ignoré", async () => {
    await writeJson(userKey("uid-1", "memory-items", "00"), { index: 0 });
    await writeJson(userKey("uid-1", "memory-items", "01"), { index: 1 });
    r2State.vanishAtRead.add("users/uid-1/memory-items/01.json");
    const documents = await listJson<{ index: number }>("users/uid-1/memory-items/");
    expect(documents).toEqual([{ index: 0 }]);
  });

  it("panne R2 (unavailable) propage MÊME avec skipCorrupted=true", async () => {
    await writeJson(userKey("uid-1", "memory-items", "00"), { index: 0 });
    r2State.failDownload = true;
    await expect(listJson("users/uid-1/memory-items/")).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});
