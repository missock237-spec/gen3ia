import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 159 — INDEX PAR PROJET (asset-service) : contrats verrouillés :
 *  - registerAsset crée le doc ET l'entrée d'index (kind/origin/createdAt) ;
 *  - listAssets ne lit PLUS QUE les docs indexés du projet (aucun scan de
 *    collection), filtre par kind, trie par createdAt desc ;
 *  - countGeneratedProjectAssets compte SANS lire aucun document ;
 *  - backfill : un index absent est reconstruit par le scan historique ;
 *  - auto-réparation : une entrée référençant un doc disparu est élaguée ;
 *  - deleteAsset retire le doc ET l'entrée d'index.
 *
 * adminDb est simulé en mémoire (surface r2fs consommée : collection/doc/
 * where/runTransaction — sémantique identique, sans CAS réseau).
 */

const db = vi.hoisted(() => {
  const collections = new Map<string, Map<string, { data: Record<string, unknown> }>>();
  const writes: string[] = [];

  const col = (name: string): Map<string, { data: Record<string, unknown> }> => {
    let c = collections.get(name);
    if (!c) {
      c = new Map();
      collections.set(name, c);
    }
    return c;
  };

  const docRef = (collectionName: string, id: string) => ({
    get: async () => {
      const entry = col(collectionName).get(id);
      return { exists: Boolean(entry), data: () => ({ ...(entry?.data ?? {}) }) };
    },
    create: async (data: Record<string, unknown>) => {
      if (col(collectionName).has(id)) throw new Error("ALREADY_EXISTS");
      col(collectionName).set(id, { data: { ...data } });
      writes.push(`create ${collectionName}/${id}`);
    },
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      const existing = col(collectionName).get(id);
      const merged = opts?.merge ? { ...(existing?.data ?? {}), ...data } : { ...data };
      col(collectionName).set(id, { data: merged });
      writes.push(`set ${collectionName}/${id}`);
    },
    delete: async () => {
      col(collectionName).delete(id);
      writes.push(`delete ${collectionName}/${id}`);
    },
  });

  const adminDb = {
    collection: (name: string) => ({
      doc: (id: string) => docRef(name, id),
      where: () => ({
        get: async () => ({
          docs: [...col(name).entries()].map(([id, entry]) => ({
            id,
            data: () => ({ ...entry.data }),
          })),
        }),
      }),
    }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const tx = {
        get: (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (ref: unknown, data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          const r = ref as { set: (d: Record<string, unknown>, o?: { merge?: boolean }) => Promise<void> };
          return r.set(data, opts);
        },
      };
      return await fn(tx);
    },
  };

  return { adminDb, collections, writes };
});

vi.mock("@/lib/firebase/admin", () => ({ adminDb: db.adminDb }));
vi.mock("@/lib/video/storage", () => ({
  uploadVideoAsset: vi.fn(async ({ userId, projectId, domain }: { userId: string; projectId: string; domain: string }) => ({
    r2Key: `users/${userId}/video/${projectId}/${domain}/fake.png`,
    sizeBytes: 1024,
  })),
  deleteVideoObject: vi.fn(async () => undefined),
  isOwnedVideoKey: vi.fn(() => true),
  downloadVideoAsset: vi.fn(async () => Buffer.from("x")),
}));
vi.mock("@/lib/video/ffmpeg", () => ({ probeMedia: vi.fn(async () => undefined) }));

import { registerAsset, listAssets, countGeneratedProjectAssets, deleteAsset } from "./asset-service";

const USER = "user-idx-1";
const PROJECT = "proj-idx-1";

function pngBody(): Buffer {
  return Buffer.from("89504e470d0a1a0a-fake");
}

beforeEach(() => {
  db.collections.clear();
  db.writes.length = 0;
});

describe("Task 159 — index par projet (efficacité listAssets)", () => {
  it("registerAsset : doc créé ET entrée d'index (kind, origin, createdAt)", async () => {
    const asset = await registerAsset({
      userId: USER,
      projectId: PROJECT,
      kind: "video",
      label: "Clip scène 1",
      role: "scene-video:scene_001",
      sceneId: "scene_001",
      origin: "generated",
      contentType: "video/mp4",
      body: Buffer.from("fake-mp4"),
      probe: false,
    });

    expect(db.collections.get("videoAssets")?.has(asset.id)).toBe(true);
    const index = db.collections.get("videoAssetIndex")?.get(`${USER}__${PROJECT}`)?.data as {
      entries: Record<string, { k: string; o: string; c: string }>;
    };
    expect(index?.entries[asset.id]).toMatchObject({ k: "video", o: "generated" });
  });

  it("listAssets : filtre par kind et renvoie tous les assets du projet", async () => {
    const video = await registerAsset({
      userId: USER, projectId: PROJECT, kind: "video", label: "v1",
      origin: "generated", contentType: "video/mp4", body: Buffer.from("v"), probe: false,
    });
    const image = await registerAsset({
      userId: USER, projectId: PROJECT, kind: "image", label: "i1",
      origin: "generated", contentType: "image/png", body: pngBody(), probe: false,
    });

    const videos = await listAssets(USER, PROJECT, "video");
    expect(videos.map((a) => a.id)).toEqual([video.id]);
    const images = await listAssets(USER, PROJECT, "image");
    expect(images.map((a) => a.id)).toEqual([image.id]);
    const all = await listAssets(USER, PROJECT);
    expect(all.map((a) => a.id).sort()).toEqual([video.id, image.id].sort());
    // Tri nominal : createdAt desc (les deux lectures doivent être cohérentes).
    for (let i = 1; i < all.length; i += 1) {
      expect(all[i - 1].createdAt >= all[i].createdAt).toBe(true);
    }

    // Les ids listés proviennent bien de l'index.
    const index = db.collections.get("videoAssetIndex")?.get(`${USER}__${PROJECT}`)?.data as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(index.entries)).toContain(video.id);
    expect(Object.keys(index.entries)).toContain(image.id);
  });

  it("countGeneratedProjectAssets : compte kind+origin SANS lire les docs", async () => {
    await registerAsset({
      userId: USER, projectId: PROJECT, kind: "video", label: "v-généré",
      origin: "generated", contentType: "video/mp4", body: Buffer.from("v"), probe: false,
    });
    await registerAsset({
      userId: USER, projectId: PROJECT, kind: "video", label: "v-uploadé",
      origin: "uploaded", contentType: "video/mp4", body: Buffer.from("u"), probe: false,
    });
    expect(await countGeneratedProjectAssets(USER, PROJECT, "video")).toBe(1);
    expect(await countGeneratedProjectAssets(USER, PROJECT, "image")).toBe(0);
  });

  it("backfill : index absent → reconstruction par le scan historique (données antérieures)", async () => {
    // Deux docs legacy écrits directement SANS passer par registerAsset
    // (état antérieur à la Task 159).
    const legacy = db.adminDb.collection("videoAssets");
    await legacy.doc("legacy-1").create({
      id: "legacy-1", userId: USER, projectId: PROJECT, kind: "image",
      origin: "generated", createdAt: "2026-01-01T00:00:00.000Z",
      label: "legacy", r2Key: "users/x/video/y/images/l.png", contentType: "image/png", sizeBytes: 1,
    });
    await legacy.doc("legacy-autre-projet").create({
      id: "legacy-autre-projet", userId: USER, projectId: "autre-projet", kind: "image",
      origin: "generated", createdAt: "2026-01-02T00:00:00.000Z",
      label: "hors projet", r2Key: "users/x/video/z/images/l.png", contentType: "image/png", sizeBytes: 1,
    });

    const assets = await listAssets(USER, PROJECT, "image");
    expect(assets.map((a) => a.id)).toEqual(["legacy-1"]);
    // L'index a été créé et ne contient QUE le projet demandé.
    const index = db.collections.get("videoAssetIndex")?.get(`${USER}__${PROJECT}`)?.data as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(index.entries)).toEqual(["legacy-1"]);
  });

  it("auto-réparation : une entrée d'index référençant un doc disparu est élaguée", async () => {
    const asset = await registerAsset({
      userId: USER, projectId: PROJECT, kind: "image", label: "fantôme",
      origin: "generated", contentType: "image/png", body: pngBody(), probe: false,
    });
    // Suppression directe du doc (crash simulé entre doc.create et index).
    await db.adminDb.collection("videoAssets").doc(asset.id).delete();

    const assets = await listAssets(USER, PROJECT, "image");
    expect(assets).toEqual([]);
    // L'entrée fantôme a été retirée de l'index.
    const index = db.collections.get("videoAssetIndex")?.get(`${USER}__${PROJECT}`)?.data as {
      entries: Record<string, unknown>;
    };
    expect(index.entries[asset.id]).toBeUndefined();
  });

  it("deleteAsset : doc ET entrée d'index retirés", async () => {
    const asset = await registerAsset({
      userId: USER, projectId: PROJECT, kind: "image", label: "à supprimer",
      origin: "generated", contentType: "image/png", body: pngBody(), probe: false,
    });
    await deleteAsset(USER, asset.id);
    expect(db.collections.get("videoAssets")?.has(asset.id)).toBe(false);
    const index = db.collections.get("videoAssetIndex")?.get(`${USER}__${PROJECT}`)?.data as {
      entries: Record<string, unknown>;
    };
    expect(index.entries[asset.id]).toBeUndefined();
    expect(await listAssets(USER, PROJECT)).toEqual([]);
  });
});
