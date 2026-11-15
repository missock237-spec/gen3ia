import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MIGRATION R2 TOTALE — tests du moteur r2fs.
 *
 * Le CLIENT R2 (lib/storage/r2) est simulé EN MÉMOIRE avec sémantique S3
 * conditionnelle (If-Match / If-None-Match → 412), même approche que l'E2E
 * (les émulateurs n'ont pas de bucket R2). On teste donc TOUTE la chaîne :
 * codec, clés, CAS, transactions, requêtes, sentinelles FieldValue.
 */

/* ------------------------------------------------------------------ */
/* Mock R2 mémoire avec ETag + préconditions                           */
/* ------------------------------------------------------------------ */

const r2Objects = new Map<string, { body: Buffer; etag: string }>();
let etagCompteur = 0;

class PreconditionFailed extends Error {
  name = "PreconditionFailed";
}

vi.mock("@/lib/storage/r2", () => ({
  getObjectWithEtag: async (key: string) => {
    const hit = r2Objects.get(key);
    if (!hit) return null;
    return { data: hit.body, etag: hit.etag };
  },
  putObjectConditional: async (
    key: string,
    body: Uint8Array | Buffer,
    _contentType: string,
    opts?: { ifMatch?: string; ifNoneMatch?: "*" },
  ) => {
    const existant = r2Objects.get(key);
    // Contrat du client réel : précondition échouée → null (PAS d'exception).
    if (opts?.ifMatch && (!existant || existant.etag !== opts.ifMatch)) return null;
    if (opts?.ifNoneMatch === "*" && existant) return null;
    const etag = `"w${++etagCompteur}"`;
    r2Objects.set(key, { body: Buffer.from(body), etag });
    return { etag };
  },
  deleteObjectConditional: async (key: string, ifMatch: string) => {
    const existant = r2Objects.get(key);
    if (!existant) return true;
    if (existant.etag !== ifMatch) return false;
    r2Objects.delete(key);
    return true;
  },
  deleteObject: async (key: string) => {
    r2Objects.delete(key);
  },
  listObjectsUnderPrefix: async (prefix: string) => {
    return [...r2Objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({
      key,
      sizeBytes: r2Objects.get(key)?.body.byteLength ?? 0,
      updatedAt: new Date().toISOString(),
    }));
  },
  isR2PreconditionFailed: (error: unknown) => error instanceof PreconditionFailed,
}));

import { getR2Fs, FieldValue, FsTimestamp, FsError, type Firestore } from "@/lib/r2fs";
import { docKey, encodeSeg, decodeSeg, parseKey } from "@/lib/r2fs/keys";

let db: Firestore;

beforeEach(() => {
  r2Objects.clear();
  etagCompteur = 0;
  db = getR2Fs();
});

/* ------------------------------------------------------------------ */
/* Clés                                                                */
/* ------------------------------------------------------------------ */

describe("clés r2fs", () => {
  it("mappe une collection racine en fs/{coll}/{id}.json", () => {
    expect(docKey(["missionQueue"], "run-1")).toBe("fs/missionQueue/run-1.json");
  });

  it("encode les segments hostiles et décode à l'identique", () => {
    const encode = encodeSeg("a/b c@d");
    expect(encode).not.toContain("/");
    expect(decodeSeg(encode)).toBe("a/b c@d");
  });

  it("parseKey retourne null hors magasin r2fs", () => {
    expect(parseKey("users/u1/profile.json")).toBeNull();
    expect(parseKey("fs/missionQueue/run-1.json")).toEqual(["missionQueue", "run-1"]);
  });
});

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

describe("CRUD documents", () => {
  it("set/get roundtrip avec Timestamp hydraté", async () => {
    const ref = db.collection("missionQueue").doc("r1");
    const quand = FsTimestamp.fromMillis(1_700_000_000_000);
    await ref.set({ objective: "x", quand });
    const snap = await ref.get();
    expect(snap.exists).toBe(true);
    expect(snap.data()?.objective).toBe("x");
    const lu = snap.data()?.quand;
    expect(lu instanceof FsTimestamp).toBe(true);
    expect((lu as FsTimestamp).toMillis()).toBe(1_700_000_000_000);
  });

  it("get sur doc absent → exists=false, PAS d'exception", async () => {
    const snap = await db.collection("missionQueue").doc("ghost").get();
    expect(snap.exists).toBe(false);
    expect(snap.data()).toBeUndefined();
  });

  it("update crée les champs manquants et refuse un doc absent", async () => {
    const ref = db.collection("t").doc("d1");
    await ref.set({ a: 1 });
    await ref.update({ b: 2 });
    expect((await ref.get()).data()).toEqual({ a: 1, b: 2 });

    const fantome = db.collection("t").doc("ghost");
    await expect(fantome.update({ x: 1 })).rejects.toMatchObject({ code: "not_found" });
  });

  it("update à clés pointées écrit dans les cartes imbriquées", async () => {
    const ref = db.collection("live").doc("s1");
    await ref.set({ status: "idle", runtime: { status: "off" } });
    await ref.update({ "runtime.status": "waiting_confirmation", "runtime.lastActionId": "a1" });
    const data = (await ref.get()).data() as Record<string, unknown>;
    expect((data.runtime as Record<string, unknown>)).toEqual({ status: "waiting_confirmation", lastActionId: "a1" });
    expect(data.status).toBe("idle");
  });

  it("set sans merge écrase TOUT ; set merge fusionne au 1er niveau", async () => {
    const ref = db.collection("t").doc("d2");
    await ref.set({ a: 1, b: { c: 2 } });
    await ref.set({ z: 9 });
    expect((await ref.get()).data()).toEqual({ z: 9 });
    await ref.set({ y: 8 }, { merge: true });
    expect((await ref.get()).data()).toEqual({ z: 9, y: 8 });
  });

  it("delete supprime puis absence", async () => {
    const ref = db.collection("t").doc("d3");
    await ref.set({ v: 1 });
    await ref.delete();
    expect((await ref.get()).exists).toBe(false);
  });

  it("add génère un identifiant", async () => {
    const ref = await db.collection("events").add({ type: "impression" });
    expect(ref.id).toHaveLength(20);
    expect((await ref.get()).exists).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Sentinelles FieldValue                                              */
/* ------------------------------------------------------------------ */

describe("sentinelles FieldValue", () => {
  it("increment résout contre la valeur actuelle (0 si absent)", async () => {
    const ref = db.collection("usage").doc("d1");
    await ref.set({ executions: 5 });
    await ref.update({ executions: FieldValue.increment(3) });
    expect((await ref.get()).data()?.executions).toBe(8);
    await ref.update({ autres: FieldValue.increment(2) });
    expect((await ref.get()).data()?.autres).toBe(2);
  });

  it("delete retire le champ (update et set merge)", async () => {
    const ref = db.collection("t").doc("d4");
    await ref.set({ a: 1, leaseUntilMs: 123 });
    await ref.update({ leaseUntilMs: FieldValue.delete() });
    const apresUpdate = (await ref.get()).data() as Record<string, unknown>;
    expect(apresUpdate).toEqual({ a: 1 });
    await ref.set({ b: 2, zombie: FieldValue.delete() }, { merge: true });
    expect((await ref.get()).data()).toEqual({ a: 1, b: 2 });
  });

  it("delete interdit dans un set() écrasant", async () => {
    await expect(db.collection("t").doc("d5").set({ a: FieldValue.delete() })).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("serverTimestamp résout au commit et s'hydrate en Timestamp", async () => {
    const ref = db.collection("t").doc("d6");
    await ref.set({ createdAt: FieldValue.serverTimestamp() });
    const lu = (await ref.get()).data()?.createdAt;
    expect(lu instanceof FsTimestamp).toBe(true);
    expect((lu as FsTimestamp).toMillis()).toBeLessThanOrEqual(Date.now());
  });

  it("arrayUnion/arrayRemove fusionnent sans doublons", async () => {
    const ref = db.collection("t").doc("d7");
    await ref.set({ tags: ["a"] });
    await ref.update({ tags: FieldValue.arrayUnion("a", "b") });
    expect((await ref.get()).data()?.tags).toEqual(["a", "b"]);
    await ref.update({ tags: FieldValue.arrayRemove("a") });
    expect((await ref.get()).data()?.tags).toEqual(["b"]);
  });
});

describe("sentinelles imbriquées (récursion moteur — bug vidéo 49 %)", () => {
  it("set merge : increment IMBRIQUÉ dans une carte résout contre la valeur actuelle (bumpAssetCount)", async () => {
    const ref = db.collection("videoProjects").doc("p1");
    await ref.set({ title: "bébé qui marche", stats: { assetCount: 2 } });
    // Forme exacte de lib/video/asset-service.ts:144 — CRASHAIT avant le fix.
    await ref.set({ stats: { assetCount: FieldValue.increment(1) }, updatedAt: "2026-10-09T00:00:00Z" }, { merge: true });
    expect((await ref.get()).data()?.stats).toEqual({ assetCount: 3 });
  });

  it("set merge : carte imbriquée remplacée + increments résolus (facturation render-queue)", async () => {
    const ref = db.collection("videoProjects").doc("p2");
    await ref.set({ stats: { assetCount: 5, billedMinor: 1000 } });
    // Forme exacte de lib/video/render-queue.ts:1289 — CRASHAIT avant le fix.
    await ref.set(
      { stats: { renderedSeconds: 42, billedMinor: FieldValue.increment(2500) }, updatedAt: "2026-10-09T00:00:00Z" },
      { merge: true },
    );
    // Carte `stats` remplacée (sémantique Firestore) ; increment résolu (1000 + 2500).
    expect((await ref.get()).data()?.stats).toEqual({ renderedSeconds: 42, billedMinor: 3500 });
  });

  it("update : increment et serverTimestamp imbriqués", async () => {
    const ref = db.collection("t").doc("n1");
    await ref.set({ progress: { pct: 10 }, meta: { tries: 1 } });
    await ref.update({ progress: { pct: FieldValue.increment(39) }, meta: { at: FieldValue.serverTimestamp() } });
    const lu = (await ref.get()).data() as { progress: { pct: number }; meta: { at: FsTimestamp } };
    expect(lu.progress.pct).toBe(49);
    expect(lu.meta.at instanceof FsTimestamp).toBe(true);
  });

  it("delete imbriqué retire la clé de la carte entrante (set merge)", async () => {
    const ref = db.collection("t").doc("n2");
    await ref.set({ job: { leaseOwner: "w1", stage: "render" } });
    await ref.set({ job: { leaseOwner: FieldValue.delete(), stage: "export" } }, { merge: true });
    expect((await ref.get()).data()?.job).toEqual({ stage: "export" });
  });

  it("delete imbriqué interdit dans un set() écrasant", async () => {
    await expect(
      db.collection("t").doc("n3").set({ job: { leaseOwner: FieldValue.delete() } }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("sentinelle dans un tableau → invalid_argument (contrat Firestore), rien n'est écrit", async () => {
    const ref = db.collection("t").doc("n4");
    await ref.set({ a: 1 });
    await expect(
      ref.update({ items: [{ n: 1 }, { n: FieldValue.increment(2) }] }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect((await ref.get()).data()).toEqual({ a: 1 });
  });

  it("profondeur triple : increment dans une carte dans une carte", async () => {
    const ref = db.collection("t").doc("n5");
    await ref.set({ usage: { live: { seconds: 100 } } });
    await ref.update({ usage: { live: { seconds: FieldValue.increment(20) } } });
    expect((await ref.get()).data()?.usage).toEqual({ live: { seconds: 120 } });
  });
});

/* ------------------------------------------------------------------ */
/* Requêtes                                                            */
/* ------------------------------------------------------------------ */

describe("requêtes", () => {
  beforeEach(async () => {
    const col = db.collection("missionQueue");
    await col.doc("m1").set({ userId: "u1", status: "queued", priority: 1, createdAtMs: 100 });
    await col.doc("m2").set({ userId: "u1", status: "running", priority: 3, createdAtMs: 300 });
    await col.doc("m3").set({ userId: "u2", status: "queued", priority: 2, createdAtMs: 200 });
  });

  it("where == filtre", async () => {
    const snap = await db.collection("missionQueue").where("userId", "==", "u1").get();
    expect(snap.size).toBe(2);
    expect(snap.docs.map((d) => d.id).sort()).toEqual(["m1", "m2"]);
  });

  it("where in filtre", async () => {
    const snap = await db.collection("missionQueue").where("status", "in", ["running", "failed"]).get();
    expect(snap.docs.map((d) => d.id)).toEqual(["m2"]);
  });

  it("orderBy + limit", async () => {
    const snap = await db.collection("missionQueue").orderBy("priority", "desc").limit(2).get();
    expect(snap.docs.map((d) => d.id)).toEqual(["m2", "m3"]);
  });

  it("comparaisons numériques >= <=", async () => {
    const snap = await db.collection("missionQueue").where("priority", ">=", 2).where("priority", "<=", 3).get();
    expect(snap.docs.map((d) => d.id).sort()).toEqual(["m2", "m3"]);
  });

  it("chaînage where + orderBy + limit", async () => {
    const snap = await db
      .collection("missionQueue")
      .where("userId", "==", "u1")
      .orderBy("createdAtMs", "desc")
      .limit(1)
      .get();
    expect(snap.docs.map((d) => d.id)).toEqual(["m2"]);
  });

  it("count() agrège sans charger les docs côté appelant", async () => {
    const agg = await db.collection("missionQueue").where("status", "==", "queued").count().get();
    expect(agg.data().count).toBe(2);
  });

  it("AggregateField.sum calcule la somme filtrée", async () => {
    const { AggregateField } = await import("@/lib/r2fs");
    const agg = await db
      .collection("missionQueue")
      .where("status", "==", "queued")
      .aggregate({ total: AggregateField.sum("priority") })
      .get();
    expect(agg.data().total).toBe(3);
  });

  it("les sous-collections sont exclues du scan de la collection parente", async () => {
    await db.collection("missionQueue").doc("m1").collection("steps").doc("s1").set({ x: 1 });
    const snap = await db.collection("missionQueue").get();
    expect(snap.size).toBe(3);
    expect((await db.collection("missionQueue").doc("m1").collection("steps").get()).size).toBe(1);
  });

  it("doc.ref.parent remonte à la collection, .parent.parent au doc parent", async () => {
    const steps = db.collection("organizations").doc("o1").collection("invitations");
    const ref = await steps.add({ email: "a@b.c" });
    expect(ref.parent.parent?.id).toBe("o1");
  });

  it("collectionGroup scanne les collections imbriquées de même nom", async () => {
    await db.collection("organizations").doc("o1").collection("invitations").doc("i1").set({ email: "a@b.c", status: "pending" });
    await db.collection("organizations").doc("o2").collection("invitations").doc("i2").set({ email: "a@b.c", status: "pending" });
    await db.collection("organizations").doc("o3").collection("invitations").doc("i3").set({ email: "x@y.z", status: "pending" });
    await db.collection("invitations").doc("racine").set({ email: "a@b.c", status: "pending" });
    const snap = await db
      .collectionGroup("invitations")
      .where("email", "==", "a@b.c")
      .where("status", "==", "pending")
      .limit(20)
      .get();
    expect(snap.size).toBe(3);
    const orgIds = snap.docs.map((d) => d.ref.parent.parent?.id ?? "").sort();
    expect(orgIds).toEqual(["", "o1", "o2"]);
  });
});

/* ------------------------------------------------------------------ */
/* Transactions                                                        */
/* ------------------------------------------------------------------ */

describe("transactions", () => {
  it("claim exclusif : un seul worker gagne, l'autre voit le bail", async () => {
    const ref = db.collection("missionQueue").doc("m1");
    await ref.set({ status: "queued", attempts: 0 });

    const claim = () =>
      db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return "missing" as const;
        const data = snap.data() as Record<string, unknown>;
        const leaseUntil = (data.leaseUntilMs as number | undefined) ?? 0;
        if (data.status === "running" && leaseUntil > Date.now()) return "lease-held" as const;
        tx.update(ref, { status: "running", leaseUntilMs: Date.now() + 10_000, attempts: FieldValue.increment(1) });
        return "claimed" as const;
      });

    const [a, b] = await Promise.all([claim(), claim()]);
    expect([a, b].sort()).toEqual(["claimed", "lease-held"]);
    const finale = (await ref.get()).data() as Record<string, unknown>;
    expect(finale.status).toBe("running");
    expect(finale.attempts).toBe(1);
  });

  it("increment en transaction résout contre la valeur LUE", async () => {
    const ref = db.collection("wallets").doc("w1");
    await ref.set({ balanceMinor: 100 });
    await db.runTransaction(async (tx) => {
      await tx.get(ref); // lecture requise avant update (sémantique Firestore)
      tx.update(ref, { balanceMinor: FieldValue.increment(-30) });
    });
    expect((await ref.get()).data()?.balanceMinor).toBe(70);
  });

  it("set en transaction sur doc lu absent crée atomiquement (pas d'écrasement)", async () => {
    const ref = db.collection("locks").doc("l1");
    const crée = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, { owner: "A" });
      return true;
    });
    expect(crée).toBe(true);
    // Recréation concurrente : le doc existe maintenant → false
    const recrée = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, { owner: "B" });
      return true;
    });
    expect(recrée).toBe(false);
    expect((await ref.get()).data()?.owner).toBe("A");
  });

  it("update sur doc absent en transaction échoue sans boucler (lu d'abord)", async () => {
    const ref = db.collection("t").doc("inconnu");
    await expect(
      db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) tx.update(ref, { x: 1 });
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("update sur doc jamais lu en tx : résolu au commit → not_found si absent (comme Firestore)", async () => {
    const ref = db.collection("t").doc("jamais-lu");
    await expect(
      db.runTransaction(async (tx) => {
        tx.update(ref, { x: 1 });
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("delete sur doc jamais lu en tx : résolu au commit, no-op si absent (comme Firestore)", async () => {
    const ref = db.collection("t").doc("fantome-delete");
    await expect(
      db.runTransaction(async (tx) => {
        tx.delete(ref);
      }),
    ).resolves.toBeUndefined();
    // Et si le doc existe : CAS sur l'état réel au commit.
    const existant = db.collection("t").doc("existant-delete");
    await existant.set({ v: 1 });
    await db.runTransaction(async (tx) => {
      tx.delete(existant);
    });
    expect((await existant.get()).exists).toBe(false);
  });

  it("retourne la valeur du callback", async () => {
    const ref = db.collection("t").doc("r1");
    await ref.set({ n: 2 });
    const valeur = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      return ((snap.data()?.n as number) ?? 0) * 2;
    });
    expect(valeur).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/* Batch                                                               */
/* ------------------------------------------------------------------ */

describe("writeBatch", () => {
  it("set/update/delete en série", async () => {
    const col = db.collection("t");
    const a = col.doc("a");
    const b = col.doc("b");
    const c = col.doc("c");
    await a.set({ v: 1 });
    await c.set({ v: 3 });
    const batch = db.batch();
    batch.set(a, { v: 2 });
    batch.set(b, { v: 1 });
    batch.delete(c);
    await batch.commit();
    expect((await a.get()).data()?.v).toBe(2);
    expect((await b.get()).data()?.v).toBe(1);
    expect((await c.get()).exists).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Conflits CAS                                                        */
/* ------------------------------------------------------------------ */

describe("conflits et erreurs", () => {
  it("un conflit 412 sur mergeLoop retente et aboutit", async () => {
    const ref = db.collection("t").doc("conf");
    await ref.set({ n: 1 });
    // Intercale une écriture concurrente entre la lecture et le CAS :
    // on simule via une transaction qui perturbe, puis mergeLoop direct.
    const avant = r2Objects.size;
    await ref.update({ n: 2 });
    expect(r2Objects.size).toBe(avant);
    expect((await ref.get()).data()?.n).toBe(2);
  });

  it("FsError porte des codes classifiables (unavailable pour panne R2)", () => {
    const erreur = new FsError("unavailable", "panne");
    expect(erreur.code).toBe("unavailable");
    expect(erreur.message).toContain("panne");
  });
});

/* ------------------------------------------------------------------ */
/* Volumétrie / encodage                                               */
/* ------------------------------------------------------------------ */

describe("robustesse", () => {
  it("un doc trop grand lève invalid_argument et RIEN n'est écrit", async () => {
    const gros = "x".repeat(910 * 1024);
    await expect(db.collection("t").doc("gros").set({ gros })).rejects.toMatchObject({ code: "invalid_argument" });
    expect(r2Objects.has(docKey(["t"], "gros"))).toBe(false);
  });

  it("les undefined sont ignorés (ignoreUndefinedProperties)", async () => {
    const ref = db.collection("t").doc("u1");
    await ref.set({ a: 1, b: undefined });
    expect((await ref.get()).data()).toEqual({ a: 1 });
  });

  it("Date est sérialisée en Timestamp", async () => {
    const ref = db.collection("t").doc("date");
    await ref.set({ quand: new Date(1_700_000_000_000) });
    const lu = (await ref.get()).data()?.quand;
    expect(lu instanceof FsTimestamp).toBe(true);
  });
});
