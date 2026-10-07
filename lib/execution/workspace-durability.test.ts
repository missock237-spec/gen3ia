import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Task 104-d — durabilité des workspaces d'exécution (reprise inter-instance).
 *
 * Mocks R2 EN MÉMOIRE + Firestore minimaliste (set merge compris) + répertoires
 * /tmp RÉELS : on teste le parcours complet snapshot → suppression locale →
 * reprise restaurée, y compris via getWorkspace (le chemin de reprise du
 * registre, comme l'emprunteraient les outils file.* après un changement
 * d'instance).
 */

const r2State = vi.hoisted(() => ({
  configured: true,
  store: new Map<string, Buffer>(),
  uploads: [] as string[],
  downloads: [] as string[],
  /** Clés dont le téléchargement renvoie un contenu corrompu. */
  corruptKeys: new Set<string>(),
  /** Sous-chaînes : clés dont le TÉLÉVERSEMENT échoue. */
  failUploadHints: new Set<string>(),
  /** Sous-chaînes : clés dont le TÉLÉCHARGEMENT échoue. */
  failDownloadHints: new Set<string>(),
  explodeList: false,
}));

vi.mock("@/lib/storage/r2", () => ({
  isR2Configured: () => r2State.configured,
  putObject: async (options: { key: string; body: Uint8Array | Buffer }) => {
    if ([...r2State.failUploadHints].some((hint) => options.key.includes(hint))) {
      throw new Error("R2 indisponible (mock)");
    }
    const buffer = Buffer.from(options.body);
    r2State.store.set(options.key, buffer);
    r2State.uploads.push(options.key);
  },
  downloadFromR2: async (key: string) => {
    r2State.downloads.push(key);
    if ([...r2State.failDownloadHints].some((hint) => key.includes(hint))) {
      throw new Error("R2 lecture impossible (mock)");
    }
    const body = r2State.store.get(key);
    if (!body) throw new Error("NoSuchKey (mock)");
    return r2State.corruptKeys.has(key) ? Buffer.from("contenu corrompu volontairement") : Buffer.from(body);
  },
  listObjectsUnderPrefix: async (prefix: string) => {
    if (r2State.explodeList) throw new Error("R2 listage impossible (mock)");
    return [...r2State.store.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, sizeBytes: r2State.store.get(key)!.length, updatedAt: "" }));
  },
}));

const docs = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: (id: string) => {
        const key = `${name}/${id}`;
        return {
          path: key,
          async get() {
            return { exists: docs.has(key), data: () => docs.get(key) };
          },
          async set(data: Record<string, unknown>, options?: { merge?: boolean }) {
            docs.set(key, options?.merge ? { ...(docs.get(key) ?? {}), ...data } : data);
            return undefined;
          },
          async delete() {
            docs.delete(key);
            return undefined;
          },
        };
      },
    }),
  },
}));

import {
  WORKSPACE_SNAPSHOT_MAX_BYTES,
  WORKSPACE_SNAPSHOT_MAX_FILES,
  __resetDurabilityCachesForTests,
  probeAndSnapshotWorkspaceIfChanged,
  rehydrateWorkspaceFromDurableStorage,
  rehydrateWorkspaceFromManifest,
  snapshotWorkspaceSafe,
  snapshotWorkspaceToDurableStorage,
  type DurableSnapshotManifest,
} from "./workspace-durability";
import { getWorkspace, registerWorkspace } from "./workspace-registry";
import { workspaceRootFor } from "./workspace";

function sha256(buffer: Buffer | string): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function manifestOf(workspaceId: string): DurableSnapshotManifest {
  const data = docs.get(`executionWorkspaces/${workspaceId}`) as
    | { durableSnapshot?: DurableSnapshotManifest }
    | undefined;
  return data?.durableSnapshot as DurableSnapshotManifest;
}

async function seedWorkspace(workspaceId: string, files: Record<string, Buffer | string>): Promise<string> {
  const root = workspaceRootFor(workspaceId);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, content, { mode: 0o600 });
  }
  return root;
}

const USED_IDS = ["ws-snap", "ws-caps-files", "ws-caps-bytes", "ws-links", "ws-upfail", "ws-missing", "ws-empty",
  "ws-restore", "ws-corrupt", "ws-nomanifest", "ws-present", "ws-dlfail", "ws-evil", "ws-cross", "ws-nor2", "ws-cooldown", "ws-safe"];

async function cleanupWorkspaces(): Promise<void> {
  await Promise.all(
    USED_IDS.map((id) => fs.rm(workspaceRootFor(id), { recursive: true, force: true }).catch(() => undefined)),
  );
}

beforeEach(async () => {
  await cleanupWorkspaces();
  r2State.configured = true;
  r2State.store.clear();
  r2State.uploads.length = 0;
  r2State.downloads.length = 0;
  r2State.corruptKeys.clear();
  r2State.failUploadHints.clear();
  r2State.failDownloadHints.clear();
  r2State.explodeList = false;
  docs.clear();
  __resetDurabilityCachesForTests();
});

describe("snapshotWorkspaceToDurableStorage", () => {
  it("téléverse les fichiers vers R2 et écrit un manifeste exact (clés de contenu, sha256, ordre taille desc)", async () => {
    await seedWorkspace("ws-snap", {
      "a.txt": "hello",
      "sub/dir/b.txt": "world-world-world", // plus gros → premier du manifeste
    });

    const result = await snapshotWorkspaceToDurableStorage("ws-snap");

    expect(result.ok).toBe(true);
    expect(result.files).toBe(2);
    expect(result.bytes).toBe(22); // 5 (a.txt) + 17 (sub/dir/b.txt)
    expect(r2State.uploads).toHaveLength(2);
    for (const key of r2State.uploads) {
      expect(key).toMatch(/^execution-workspaces\/ws-snap\/[0-9a-f]{12}\//);
    }

    const manifest = manifestOf("ws-snap");
    expect(manifest.version).toBe(1);
    expect(manifest.workspaceId).toBe("ws-snap");
    expect(manifest.partial).toBe(false);
    expect(manifest.filesCount).toBe(2);
    expect(manifest.files.map((entry) => entry.path)).toEqual(["sub/dir/b.txt", "a.txt"]);

    const entryA = manifest.files.find((entry) => entry.path === "a.txt")!;
    expect(entryA.sha256).toBe(sha256("hello"));
    expect(entryA.sizeBytes).toBe(5);
    expect(r2State.store.get(entryA.r2Key)?.toString()).toBe("hello");
    // Le hash12 de la clé = 12 premiers caractères du sha256 du contenu.
    expect(entryA.r2Key).toContain(`/${entryA.sha256.slice(0, 12)}/a.txt`);

    const entryB = manifest.files.find((entry) => entry.path === "sub/dir/b.txt")!;
    expect(r2State.store.get(entryB.r2Key)?.toString()).toBe("world-world-world");
  });

  it("re-snapshot à contenu inchangé → aucun re-téléversement (déduplication mémoire)", async () => {
    await seedWorkspace("ws-snap", { "a.txt": "hello" });
    await snapshotWorkspaceToDurableStorage("ws-snap");
    expect(r2State.uploads).toHaveLength(1);

    const second = await snapshotWorkspaceToDurableStorage("ws-snap");

    expect(second.ok).toBe(true);
    expect(second.reason).toBe("unchanged");
    expect(r2State.uploads).toHaveLength(1); // pas de re-téléversement
  });

  it("cap de fichiers : au-delà de 80 → snapshot PARTIEL explicite (file_cap_exceeded)", async () => {
    const files: Record<string, Buffer> = {};
    for (let index = 0; index < WORKSPACE_SNAPSHOT_MAX_FILES + 5; index += 1) {
      files[`f${String(index).padStart(3, "0")}.txt`] = Buffer.from(`contenu-${index}`);
    }
    await seedWorkspace("ws-caps-files", files);

    const result = await snapshotWorkspaceToDurableStorage("ws-caps-files");

    expect(result.ok).toBe(true);
    expect(result.files).toBe(WORKSPACE_SNAPSHOT_MAX_FILES);
    expect(result.reason).toContain("file_cap_exceeded");
    expect(r2State.uploads).toHaveLength(WORKSPACE_SNAPSHOT_MAX_FILES);
    expect(manifestOf("ws-caps-files").partial).toBe(true);
  });

  it("cap d'octets : fichier trop gros exclu avec raison, les petits passent (remplissage glouton)", async () => {
    await seedWorkspace("ws-caps-bytes", {
      // Un Mio de plus que le cap strict WORKSPACE_SNAPSHOT_MAX_BYTES (40 Mio).
      "gros.bin": Buffer.alloc(WORKSPACE_SNAPSHOT_MAX_BYTES + 1024 * 1024, 7),
      "petit.txt": "ok",
    });

    const result = await snapshotWorkspaceToDurableStorage("ws-caps-bytes");

    expect(result.ok).toBe(true);
    expect(result.files).toBe(1);
    expect(result.bytes).toBe(2);
    expect(result.reason).toContain("byte_cap_exceeded");
    expect(r2State.uploads).toHaveLength(1);
    expect(r2State.uploads[0]!.endsWith("/petit.txt")).toBe(true);
  });

  it("les liens symboliques ne sont JAMAIS téléversés ni traversés", async () => {
    const root = await seedWorkspace("ws-links", { "a.txt": "hello" });
    await fs.symlink(path.join(root, "a.txt"), path.join(root, "lien.txt"));
    await fs.symlink("/etc", path.join(root, "dir-lien"));

    const result = await snapshotWorkspaceToDurableStorage("ws-links");

    expect(result.ok).toBe(true);
    expect(result.files).toBe(1);
    expect(r2State.uploads).toHaveLength(1);
    expect(r2State.uploads[0]!.endsWith("/a.txt")).toBe(true);
    expect(manifestOf("ws-links").files.map((entry) => entry.path)).toEqual(["a.txt"]);
  });

  it("échec de téléversement d'un fichier → exclu du manifeste, sans lever", async () => {
    await seedWorkspace("ws-upfail", { "good.txt": "ok", "bad.txt": "ko" });
    r2State.failUploadHints.add("/bad.txt");

    const result = await snapshotWorkspaceToDurableStorage("ws-upfail");

    expect(result.ok).toBe(true);
    expect(result.files).toBe(1);
    expect(manifestOf("ws-upfail").files.map((entry) => entry.path)).toEqual(["good.txt"]);
  });

  it("répertoire local absent → { ok:false, reason:'workspace_dir_missing' } sans lever", async () => {
    const result = await snapshotWorkspaceToDurableStorage("ws-missing");
    expect(result).toEqual({ ok: false, files: 0, bytes: 0, reason: "workspace_dir_missing" });
    expect(docs.has("executionWorkspaces/ws-missing")).toBe(false);
  });

  it("scan vide avec manifeste existant non vide → copie durable PRÉSERVÉE (pas d'écrasement)", async () => {
    await seedWorkspace("ws-empty", { "a.txt": "hello" });
    await snapshotWorkspaceToDurableStorage("ws-empty");
    await fs.rm(workspaceRootFor("ws-empty/a.txt"));

    const result = await snapshotWorkspaceToDurableStorage("ws-empty");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("empty_scan_preserved");
    expect(manifestOf("ws-empty").filesCount).toBe(1); // manifeste intact
  });

  it("R2 non configuré → { ok:false, reason:'r2_unconfigured' } sans lever, aucune écriture", async () => {
    await seedWorkspace("ws-nor2", { "a.txt": "hello" });
    r2State.configured = false;

    const result = await snapshotWorkspaceToDurableStorage("ws-nor2");

    expect(result).toEqual({ ok: false, files: 0, bytes: 0, reason: "r2_unconfigured" });
    expect(docs.has("executionWorkspaces/ws-nor2")).toBe(false);
  });
});

describe("rehydrateWorkspaceFromDurableStorage", () => {
  it("répertoire local supprimé → restauré INTÉGRALEMENT (contenu + hash vérifiés, registre estampillé)", async () => {
    await seedWorkspace("ws-restore", { "a.txt": "hello", "sub/deep/b.txt": "world" });
    await snapshotWorkspaceToDurableStorage("ws-restore");
    await fs.rm(workspaceRootFor("ws-restore"), { recursive: true, force: true });

    const result = await rehydrateWorkspaceFromDurableStorage("ws-restore");

    expect(result.ok).toBe(true);
    expect(result.restored).toBe(2);
    const root = workspaceRootFor("ws-restore");
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("hello");
    expect(await fs.readFile(path.join(root, "sub/deep/b.txt"), "utf8")).toBe("world");
    // Permissions du répertoire restauré : 0700 (staging mkdtemp + chmod).
    const stat = await fs.stat(root);
    expect(stat.mode & 0o777).toBe(0o700);
    // Registre mis à jour : estampille de reprise (merge sur le doc existant).
    expect(manifestOf("ws-restore").lastRestoredAtMs).toBeGreaterThan(0);
    expect(manifestOf("ws-restore").restoredCount).toBe(2);
  });

  it("fichier corrompu côté stockage → exclu avec raison, les autres restaurés", async () => {
    await seedWorkspace("ws-corrupt", { "a.txt": "hello", "b.txt": "world" });
    await snapshotWorkspaceToDurableStorage("ws-corrupt");
    const manifest = manifestOf("ws-corrupt");
    const corrupted = manifest.files.find((entry) => entry.path === "a.txt")!;
    r2State.corruptKeys.add(corrupted.r2Key);
    await fs.rm(workspaceRootFor("ws-corrupt"), { recursive: true, force: true });

    const result = await rehydrateWorkspaceFromDurableStorage("ws-corrupt");

    expect(result.ok).toBe(true);
    expect(result.restored).toBe(1);
    expect(result.reason).toBe("excluded_files:1");
    const root = workspaceRootFor("ws-corrupt");
    expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("world");
    await expect(fs.readFile(path.join(root, "a.txt"), "utf8")).rejects.toThrow();
  });

  it("téléchargements tous en échec → { ok:false, restore_failed } et répertoire NON créé (retentable)", async () => {
    await seedWorkspace("ws-dlfail", { "a.txt": "hello" });
    await snapshotWorkspaceToDurableStorage("ws-dlfail");
    r2State.failDownloadHints.add("ws-dlfail/");
    await fs.rm(workspaceRootFor("ws-dlfail"), { recursive: true, force: true });

    const result = await rehydrateWorkspaceFromDurableStorage("ws-dlfail");

    expect(result).toEqual({ ok: false, restored: 0, reason: "restore_failed" });
    await expect(fs.stat(workspaceRootFor("ws-dlfail"))).rejects.toThrow();
  });

  it("manifeste absent → { ok:false, reason:'no_durable_snapshot' } sans lever", async () => {
    const result = await rehydrateWorkspaceFromDurableStorage("ws-nomanifest");
    expect(result).toEqual({ ok: false, restored: 0, reason: "no_durable_snapshot" });
  });

  it("R2 non configuré → { ok:false, reason:'r2_unconfigured' } sans lever", async () => {
    r2State.configured = false;
    const result = await rehydrateWorkspaceFromDurableStorage("ws-nor2");
    expect(result).toEqual({ ok: false, restored: 0, reason: "r2_unconfigured" });
  });

  it("répertoire local déjà présent → NON destructif (contenu local conservé)", async () => {
    await seedWorkspace("ws-present", { "a.txt": "hello" });
    await snapshotWorkspaceToDurableStorage("ws-present");
    await fs.writeFile(workspaceRootFor("ws-present/a.txt"), "local-plus-recent", "utf8");

    const result = await rehydrateWorkspaceFromDurableStorage("ws-present");

    expect(result).toEqual({ ok: true, restored: 0, reason: "already_present" });
    expect(await fs.readFile(workspaceRootFor("ws-present/a.txt"), "utf8")).toBe("local-plus-recent");
  });

  it("manifeste hostile (chemin de traversée) → entrées dangereuses ignorées, aucune fuite hors workspace", async () => {
    const content = "contenu-legitime";
    const r2Key = "execution-workspaces/ws-evil/abc123def456/ok.txt";
    r2State.store.set(r2Key, Buffer.from(content));
    const hostileManifest: DurableSnapshotManifest = {
      version: 1,
      workspaceId: "ws-evil",
      atMs: Date.now(),
      partial: false,
      filesCount: 2,
      totalBytes: content.length,
      files: [
        { path: "../104d-evil-probe", sizeBytes: 3, sha256: sha256("x"), r2Key: "execution-workspaces/ws-evil/x/evil" },
        { path: "ok.txt", sizeBytes: content.length, sha256: sha256(content), r2Key },
      ],
    };
    docs.set("executionWorkspaces/ws-evil", { id: "ws-evil", durableSnapshot: hostileManifest });

    const result = await rehydrateWorkspaceFromManifest("ws-evil", hostileManifest);

    expect(result.ok).toBe(true);
    expect(result.restored).toBe(1);
    expect(await fs.readFile(workspaceRootFor("ws-evil/ok.txt"), "utf8")).toBe(content);
    await expect(fs.stat(path.join(os.tmpdir(), "104d-evil-probe"))).rejects.toThrow();
  });
});

describe("reprise sur une AUTRE instance (via le registre — chemin de reprise réel)", () => {
  it("getWorkspace restaure le workspace depuis le stockage durable quand le répertoire local a disparu", async () => {
    await seedWorkspace("ws-cross", { "mission/etape1.txt": "résultat de la tranche 1" });
    await registerWorkspace({ id: "ws-cross", root: workspaceRootFor("ws-cross") }, "user-1", "exec-1");
    await snapshotWorkspaceToDurableStorage("ws-cross");
    // Simulation du changement d'instance : le répertoire /tmp local n'existe plus.
    await fs.rm(workspaceRootFor("ws-cross"), { recursive: true, force: true });

    const record = await getWorkspace("ws-cross");

    expect(record).not.toBeNull();
    expect(record!.root).toBe(workspaceRootFor("ws-cross"));
    // Le workspace restauré est utilisable immédiatement (pas d'ENOENT).
    expect(await fs.readFile(path.join(record!.root, "mission/etape1.txt"), "utf8")).toBe(
      "résultat de la tranche 1",
    );
    expect(manifestOf("ws-cross").lastRestoredAtMs).toBeGreaterThan(0);
    // Drain du checkpoint fire-and-forget déclenché par la sonde de getWorkspace.
    await snapshotWorkspaceSafe("ws-cross");
  });

  it("getWorkspace sans R2 configuré → comportement inchangé (aucun répertoire créé, aucune exception)", async () => {
    r2State.configured = false;
    await registerWorkspace({ id: "ws-nor2", root: "/tmp/x" }, "user-1", "exec-1");

    const record = await getWorkspace("ws-nor2");

    expect(record).not.toBeNull();
    await expect(fs.stat(workspaceRootFor("ws-nor2"))).rejects.toThrow();
  });

  it("cooldown : après un échec de reprise, getWorkspace ne re-tente pas immédiatement R2", async () => {
    await seedWorkspace("ws-cooldown", { "a.txt": "hello" });
    await registerWorkspace({ id: "ws-cooldown", root: workspaceRootFor("ws-cooldown") }, "user-1", "exec-1");
    await snapshotWorkspaceToDurableStorage("ws-cooldown");
    r2State.corruptKeys.add([...r2State.store.keys()][0]!); // tout téléchargement échoue au contrôle

    await fs.rm(workspaceRootFor("ws-cooldown"), { recursive: true, force: true });
    const first = await getWorkspace("ws-cooldown"); // reprise en échec (restore_failed)
    expect(first).not.toBeNull();
    const downloadsAfterFirst = r2State.downloads.length;
    expect(downloadsAfterFirst).toBeGreaterThan(0);

    await fs.rm(workspaceRootFor("ws-cooldown"), { recursive: true, force: true });
    await getWorkspace("ws-cooldown"); // dans le cooldown : aucune re-tentative
    expect(r2State.downloads.length).toBe(downloadsAfterFirst);
  });
});

describe("checkpoint continu (sonde de changement)", () => {
  it("au changement de contenu → snapshot déclenché ; à l'identique → aucun re-téléversement", async () => {
    await seedWorkspace("ws-snap", { "a.txt": "v1" });

    await probeAndSnapshotWorkspaceIfChanged("ws-snap");
    await snapshotWorkspaceSafe("ws-snap"); // coalescé avec le fire-and-forget de la sonde
    expect(r2State.uploads).toHaveLength(1);

    await probeAndSnapshotWorkspaceIfChanged("ws-snap"); // contenu inchangé → rien
    await snapshotWorkspaceSafe("ws-snap");
    expect(r2State.uploads).toHaveLength(1);

    await fs.writeFile(workspaceRootFor("ws-snap/a.txt"), "v2", "utf8");
    await probeAndSnapshotWorkspaceIfChanged("ws-snap");
    await snapshotWorkspaceSafe("ws-snap");
    expect(r2State.uploads).toHaveLength(2);
    const manifest = manifestOf("ws-snap");
    expect(manifest.filesCount).toBe(1);
    expect(r2State.store.get(manifest.files[0]!.r2Key)?.toString()).toBe("v2");
  });

  it("fire-and-forget SÉCURISÉ : snapshotWorkspaceSafe ne lève JAMAIS, même infra R2 en feu", async () => {
    await seedWorkspace("ws-safe", { "a.txt": "hello" });
    r2State.explodeList = true;
    r2State.failUploadHints.add("execution-workspaces/");

    await expect(snapshotWorkspaceSafe("ws-safe")).resolves.toBeUndefined();
    expect(r2State.uploads).toHaveLength(0);
  });
});

describe("gardes structurelles (source)", () => {
  const durabilitySource = readFileSync(path.resolve("lib/execution/workspace-durability.ts"), "utf8");
  const registrySource = readFileSync(path.resolve("lib/execution/workspace-registry.ts"), "utf8");

  it("workspace-durability.ts référence bien les caps et n'expose que des caps stricts", () => {
    expect(durabilitySource).toContain("export const WORKSPACE_SNAPSHOT_MAX_FILES = 80;");
    expect(durabilitySource).toContain("export const WORKSPACE_SNAPSHOT_MAX_BYTES = 40 * 1024 * 1024;");
    expect(durabilitySource).toContain("WORKSPACE_SNAPSHOT_MAX_FILES");
    expect(durabilitySource).toContain("WORKSPACE_SNAPSHOT_MAX_BYTES");
  });

  it("workspace-durability.ts ne téléverse jamais de liens symboliques (garde source)", () => {
    expect(durabilitySource).toContain("entry.isSymbolicLink()"); // exclusion au parcours
    expect(durabilitySource).toContain("fs.lstat"); // re-vérification avant lecture
  });

  it("manifeste écrit en merge dans le document de registre existant (un seul champ durableSnapshot)", () => {
    expect(durabilitySource).toContain("{ merge: true }");
    expect(durabilitySource).toContain("durableSnapshot:");
    expect(durabilitySource).toContain('registryDoc(workspaceId).set({ durableSnapshot: manifest }, { merge: true })');
  });

  it("clé R2 déterministe au format execution-workspaces/<id>/<hash12>/<chemin>", () => {
    expect(durabilitySource).toContain('const R2_PREFIX = "execution-workspaces";');
    expect(durabilitySource).toContain("${R2_PREFIX}/${workspaceId}/${contentHash12}/${relativePath}");
  });

  it("intégration appelée aux points de reprise/checkpoint du registre (workspace-registry.ts)", () => {
    // Reprise : restauration AVANT de rendre le workspace.
    expect(registrySource).toContain("rehydrateWorkspaceIfLocalMissing(data.id, data.durableSnapshot)");
    // Checkpoint : registerWorkspace (fire-and-forget sécurisé) + sonde dans getWorkspace.
    expect(registrySource).toContain("void snapshotWorkspaceSafe(workspace.id);");
    expect(registrySource).toContain("probeAndSnapshotWorkspaceIfChanged(data.id)");
    // set en merge : le champ durableSnapshot survit aux ré-enregistrements.
    expect(registrySource).toContain("{ merge: true }");
  });
});
