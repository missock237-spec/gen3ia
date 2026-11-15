import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { adminDb } from "@/lib/firebase/admin";
import {
  downloadFromR2,
  isR2Configured,
  listObjectsUnderPrefix,
  putObject,
} from "@/lib/storage/r2";

import { workspaceRootFor } from "./workspace";

/**
 * DURABILITÉ DES WORKSPACES D'EXÉCUTION (Task 104-d — reprise inter-instance).
 *
 * RISQUE COUVERT : les fichiers de workspace vivent sous /tmp, instance-local
 * par conception (voir workspace.ts). Une reprise de mission longue (tranche
 * QStash) sur une AUTRE instance serverless trouvait un répertoire absent et
 * échouait avec l'ENOENT « honnête » documenté dans workspace-registry — le
 * registre Firestore garantit la PROPRIÉTÉ, pas le CONTENU.
 *
 * PRINCIPE : un instantané du contenu (fichiers réguliers uniquement, liens
 * symboliques jamais traversés ni téléversés) est téléversé vers R2 sous des
 * clés déterministes, et le manifeste (liste + empreintes sha256 + tailles +
 * clés R2) vit dans UN SEUL champ `durableSnapshot` du document de registre
 * existant (écriture en merge — aucun nouveau pattern d'écriture, politique
 * quota Task 102). À la REPRISE, si le répertoire local est absent et qu'un
 * manifeste existe, le contenu est restauré depuis R2 AVANT de rendre le
 * workspace (points d'intégration dans workspace-registry.ts : getWorkspace
 * pour la reprise, registerWorkspace pour le checkpoint par usage).
 *
 * COÛTS MAÎTRISÉS :
 *  - caps stricts (WORKSPACE_SNAPSHOT_MAX_FILES / _MAX_BYTES) : au dépassement,
 *    snapshot PARTIEL explicite avec raison stable ;
 *  - déduplication en mémoire (Map statiques d'instance) : une sonde locale
 *    bon marché (readdir+stat) ne déclenche le snapshot complet qu'au
 *    CHANGEMENT de contenu ; un manifeste identique au dernier téléversé
 *    (même instance) ou à celui du registre (autre instance) ne provoque
 *    ni téléversement ni écriture Firestore ;
 *  - clés de contenu : le même fichier (même empreinte, même chemin) n'est
 *    pas re-téléversé si l'objet existe déjà dans R2 (listObjectsUnderPrefix) ;
 *  - R2 NON CONFIGURÉ → comportement actuel inchangé : aucun accès fs
 *    supplémentaire, { ok:false, reason:"r2_unconfigured" }, jamais de throw.
 *
 * LIMITES ASSUMÉES : les sessions terminal interactives (sandbox /workspace)
 * ne passent PAS par les workspaces /tmp — hors périmètre ; les fichiers
 * modifiés après le DERNIER checkpoint (fin de tranche sans nouvel usage) ne
 * sont pas durables tant qu'aucun hook fin-de-tick n'existe dans lib/ (les
 * fichiers runners/queue sont hors périmètre Task 104-d).
 */

/** Nombre maximal de fichiers par snapshot (au-delà : partiel explicite). */
export const WORKSPACE_SNAPSHOT_MAX_FILES = 80;

/** Nombre maximal d'octets par snapshot (au-delà : partiel explicite). */
export const WORKSPACE_SNAPSHOT_MAX_BYTES = 40 * 1024 * 1024;

/** Plafond dur du parcours (anti-DoS sur un workspace géant). */
const WALK_HARD_CAP_FILES = 2_000;

/** Taille de la sonde de changement (fichiers comparés sans téléverser). */
const PROBE_MAX_ENTRIES = 200;

/** Intervalle minimal entre deux snapshots forcés quand la sonde est tronquée. */
const TRUNCATED_PROBE_MIN_INTERVAL_MS = 60_000;

/** Silence après un échec de restauration (anti-marteau sur la reprise). */
const REHYDRATE_COOLDOWN_MS = 30_000;

/** Préfixe R2 de tous les instantanés de workspaces d'exécution. */
const R2_PREFIX = "execution-workspaces";

/** Collection du registre (miroir de workspace-registry.ts : importer ce
 * module depuis ici créerait un cycle workspace-registry → durabilité →
 * workspace-registry ; la constante est dupliquée volontairement). */
const REGISTRY_COLLECTION = "executionWorkspaces";

export interface DurableSnapshotFileEntry {
  /** Chemin relatif (séparateurs « / », sans traversée). */
  path: string;
  sizeBytes: number;
  /** Empreinte sha256 hex (64 caractères) du contenu téléversé. */
  sha256: string;
  /** Clé R2 déterministe : execution-workspaces/<id>/<hash12>/<chemin>. */
  r2Key: string;
}

export interface DurableSnapshotManifest {
  version: 1;
  workspaceId: string;
  atMs: number;
  /** true si des fichiers ont été laissés de côté (caps ou échecs d'upload). */
  partial: boolean;
  /** Raison stable de la troncature (file_cap_exceeded, byte_cap_exceeded, …). */
  reason?: string;
  filesCount: number;
  totalBytes: number;
  files: DurableSnapshotFileEntry[];
  /** Estampille de la dernière reprise inter-instance (écrite par la restauration). */
  lastRestoredAtMs?: number;
  restoredCount?: number;
}

export interface WorkspaceSnapshotResult {
  ok: boolean;
  files: number;
  bytes: number;
  reason?: string;
}

export interface WorkspaceRehydrateResult {
  ok: boolean;
  restored: number;
  reason?: string;
}

interface ScannedFile {
  relative: string;
  absolute: string;
  sizeBytes: number;
  mtimeMs: number;
}

/* ------------------------------------------------------------------ */
/* Mémoires d'instance — cohérent avec le modèle serverless : elles    */
/* n'optimisent qu'une instance tiède, le registre Firestore fait foi  */
/* entre instances (comparaison de manifestes intégrée au snapshot).   */
/* ------------------------------------------------------------------ */

/** Dernière signature de contenu sondée par workspace (évite les scans complets). */
const lastProbeSignatures = new Map<string, string>();
/** Dernier hash de manifeste téléversé par workspace (UN SEUL snapshot par tick). */
const lastManifestSignatures = new Map<string, string>();
/** Dernier snapshot forcé sur sonde tronquée (> PROBE_MAX_ENTRIES fichiers). */
const lastTruncatedProbeAtMs = new Map<string, number>();
/** Cooldown de restauration après échec (anti-marteau reprise). */
const rehydrateCooldownUntilMs = new Map<string, number>();
/** Snapshots en cours (coalescence des déclenchements simultanés). */
const inFlightSnapshots = new Map<string, Promise<void>>();

const MEMORY_MAP_MAX_ENTRIES = 512;

function rememberBounded<T>(map: Map<string, T>, key: string, value: T): void {
  if (map.size >= MEMORY_MAP_MAX_ENTRIES && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (typeof oldest === "string") map.delete(oldest);
  }
  map.set(key, value);
}

/** Réinitialise les mémoires de durabilité (réservé aux tests). */
export function __resetDurabilityCachesForTests(): void {
  lastProbeSignatures.clear();
  lastManifestSignatures.clear();
  lastTruncatedProbeAtMs.clear();
  rehydrateCooldownUntilMs.clear();
  inFlightSnapshots.clear();
}

/* ------------------------------------------------------------------ */
/* Primitifs                                                           */
/* ------------------------------------------------------------------ */

function registryDoc(workspaceId: string) {
  return adminDb.collection(REGISTRY_COLLECTION).doc(workspaceId);
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** Clé R2 déterministe : contenu (12 premiers hex du sha256) + chemin relatif. */
function durableObjectKey(workspaceId: string, contentHash12: string, relativePath: string): string {
  return `${R2_PREFIX}/${workspaceId}/${contentHash12}/${relativePath}`;
}

/** Empreinte stable d'un manifeste (hors estampilles temporelles) : sert à la
 * déduplication mémoire ET à la comparaison avec le manifeste du registre. */
function manifestSignature(
  manifest: Pick<DurableSnapshotManifest, "partial" | "files"> & { reason?: string },
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ partial: manifest.partial, reason: manifest.reason ?? null, files: manifest.files }))
    .digest("hex")
    .slice(0, 24);
}

/**
 * Parcours récursif des fichiers RÉGULIERS du workspace : les liens
 * symboliques ne sont JAMAIS traversés ni sélectionnés (re-vérification
 * lstat avant lecture) ; sockets/FIFO/devices exclus ; sous-répertoires
 * illisibles ignorés (snapshot best-effort).
 */
async function walkWorkspaceFiles(
  root: string,
  maxEntries: number,
): Promise<{ files: ScannedFile[]; truncated: boolean }> {
  const files: ScannedFile[] = [];
  const stack: string[] = [root];
  let truncated = false;
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // répertoire disparu/illisible : branche ignorée
    }
    for (const entry of entries) {
      // Liens symboliques : jamais suivis ni téléversés (Task 104-d).
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue; // sockets, FIFO, devices : hors périmètre
      if (files.length >= maxEntries) {
        truncated = true;
        return { files, truncated };
      }
      // lstat (et non stat) : refuse un fichier remplacé par un lien symbolique entre-temps.
      const stat = await fs.lstat(absolute).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      files.push({
        relative: path.relative(root, absolute).split(path.sep).join("/"),
        absolute,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  return { files, truncated };
}

/** Sonde locale bon marché (readdir + lstat plafonnés) : signature du contenu. */
async function probeWorkspaceSignature(root: string): Promise<{ signature: string; truncated: boolean }> {
  const scanned = await walkWorkspaceFiles(root, PROBE_MAX_ENTRIES);
  if (scanned.files.length === 0) {
    // Répertoire absent OU vide : rien à préserver côté stockage durable.
    return { signature: "empty", truncated: false };
  }
  const fingerprint = scanned.files
    .map((file) => `${file.relative}:${file.sizeBytes}:${file.mtimeMs}`)
    .join("|");
  return {
    signature: crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 24),
    truncated: scanned.truncated,
  };
}

/** Chemin relatif restaurable : anti-traversée stricte (le manifeste est une
 * donnée persistée — il est validé défensivement à la restauration). */
function isSafeRestoreRelativePath(relative: string): boolean {
  if (typeof relative !== "string" || !relative || relative.length > 512) return false;
  if (relative.includes("\\") || relative.includes("\0")) return false;
  if (relative.startsWith("/")) return false;
  const segments = relative.split("/");
  if (segments.length > 24) return false;
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

async function readDurableSnapshot(workspaceId: string): Promise<DurableSnapshotManifest | null> {
  const snap = await registryDoc(workspaceId).get();
  const data = snap.data() as { durableSnapshot?: DurableSnapshotManifest } | undefined;
  const manifest = data?.durableSnapshot;
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files)) return null;
  return manifest;
}

/* ------------------------------------------------------------------ */
/* SNAPSHOT (workspace local → R2 + manifeste dans le registre)        */
/* ------------------------------------------------------------------ */

/**
 * Téléverse un instantané du workspace vers R2 puis écrit le manifeste dans
 * le document de registre Firestore (UN SEUL champ `durableSnapshot`, merge).
 *
 * Ne lève JAMAIS : les erreurs sont loggées (console FR) et retournées sous
 * forme { ok:false, reason }. R2 non configuré → { ok:false,
 * reason:"r2_unconfigured" } (comportement actuel préservé).
 */
export async function snapshotWorkspaceToDurableStorage(
  workspaceId: string,
): Promise<WorkspaceSnapshotResult> {
  if (!isR2Configured()) {
    return { ok: false, files: 0, bytes: 0, reason: "r2_unconfigured" };
  }
  try {
    const root = workspaceRootFor(workspaceId);
    const rootStat = await fs.stat(root).catch(() => null);
    if (!rootStat || !rootStat.isDirectory()) {
      return { ok: false, files: 0, bytes: 0, reason: "workspace_dir_missing" };
    }
    const walk = await walkWorkspaceFiles(root, WALK_HARD_CAP_FILES);
    if (walk.files.length === 0) {
      // Rien à préserver. Un manifeste existant non vide n'est JAMAIS écrasé
      // par un scan vide (la copie durable reste la meilleure connue).
      const existing = await readDurableSnapshot(workspaceId).catch(() => null);
      if (existing && existing.filesCount > 0) {
        return { ok: false, files: 0, bytes: 0, reason: "empty_scan_preserved" };
      }
      return { ok: true, files: 0, bytes: 0, reason: "empty" };
    }

    // Tri par taille décroissante puis application des caps : remplissage
    // glouton (un fichier plus petit peut encore entrer après un gros exclu).
    const sorted = [...walk.files].sort(
      (a, b) => b.sizeBytes - a.sizeBytes || a.relative.localeCompare(b.relative),
    );
    const kept: ScannedFile[] = [];
    let keptBytes = 0;
    let fileCapHit = walk.truncated;
    let byteCapHit = false;
    for (const file of sorted) {
      if (kept.length >= WORKSPACE_SNAPSHOT_MAX_FILES) {
        fileCapHit = true;
        continue;
      }
      if (keptBytes + file.sizeBytes > WORKSPACE_SNAPSHOT_MAX_BYTES) {
        byteCapHit = true;
        continue;
      }
      kept.push(file);
      keptBytes += file.sizeBytes;
    }
    const capReasons = [
      fileCapHit ? "file_cap_exceeded" : null,
      byteCapHit ? "byte_cap_exceeded" : null,
      walk.truncated ? "walk_truncated" : null,
    ].filter((value): value is string => Boolean(value));
    const capReason = capReasons.length > 0 ? capReasons.join("+") : undefined;
    const partial = capReasons.length > 0;

    if (kept.length === 0) {
      // Tous les fichiers hors caps : rien de restaurable ne résulterait d'un
      // manifeste vide → pas d'écriture.
      return { ok: false, files: 0, bytes: 0, reason: capReason ?? "empty" };
    }

    // Lecture + empreinte des fichiers retenus (les buffers sont conservés
    // pour téléverser EXACTEMENT les octets dont l'empreinte est écrite).
    const buffers = new Map<string, Buffer>();
    const entries: DurableSnapshotFileEntry[] = [];
    for (const file of kept) {
      const buffer = await fs.readFile(file.absolute).catch(() => null);
      if (!buffer) {
        console.warn(`[workspace] fichier illisible au snapshot, exclu : ${file.relative}`);
        continue;
      }
      const contentSha = sha256Hex(buffer);
      entries.push({
        path: file.relative,
        sizeBytes: buffer.length,
        sha256: contentSha,
        r2Key: durableObjectKey(workspaceId, contentSha.slice(0, 12), file.relative),
      });
      buffers.set(file.relative, buffer);
    }
    if (entries.length === 0) {
      return { ok: false, files: 0, bytes: 0, reason: "read_failed" };
    }

    // Déduplication mémoire (mission : UN SEUL snapshot par workspace/tick) :
    // manifeste identique au dernier téléversé sur cette instance → stop.
    const candidateSignature = manifestSignature({ partial, reason: capReason, files: entries });
    if (lastManifestSignatures.get(workspaceId) === candidateSignature) {
      return {
        ok: true,
        files: entries.length,
        bytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
        reason: capReason ?? "unchanged",
      };
    }

    // Idempotence inter-instances : manifeste identique à celui du registre →
    // aucun téléversement ni écriture Firestore (instance froide qui rejoue).
    const existing = await readDurableSnapshot(workspaceId).catch(() => null);
    if (
      existing &&
      existing.filesCount > 0 &&
      manifestSignature({ partial: existing.partial, reason: existing.reason, files: existing.files }) === candidateSignature
    ) {
      rememberBounded(lastManifestSignatures, workspaceId, candidateSignature);
      return {
        ok: true,
        files: entries.length,
        bytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
        reason: capReason ?? "unchanged",
      };
    }

    // Objets déjà présents : pas de re-téléversement (clés de contenu).
    let existingKeys = new Set<string>();
    try {
      const listed = await listObjectsUnderPrefix(`${R2_PREFIX}/${workspaceId}/`, 500);
      existingKeys = new Set(listed.map((object) => object.key));
    } catch (error) {
      console.warn(
        "[workspace] listage R2 impossible (re-téléversement systématique):",
        error instanceof Error ? error.message : error,
      );
    }

    const uploadedEntries: DurableSnapshotFileEntry[] = [];
    for (const entry of entries) {
      if (existingKeys.has(entry.r2Key)) {
        uploadedEntries.push(entry);
        continue;
      }
      const buffer = buffers.get(entry.path);
      if (!buffer) continue; // ne devrait pas arriver (buffers construits avec entries)
      try {
        await putObject({
          key: entry.r2Key,
          body: buffer,
          contentType: "application/octet-stream",
          contentLength: buffer.byteLength,
        });
        uploadedEntries.push(entry);
      } catch (error) {
        // Un fichier en échec est exclu du manifeste : le manifeste reflète
        // TOUJOURS ce qui est réellement restaurable depuis R2.
        console.warn(
          `[workspace] téléversement R2 impossible (fichier exclu du manifeste) : ${entry.path}`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    if (uploadedEntries.length === 0) {
      return { ok: false, files: 0, bytes: 0, reason: "upload_failed" };
    }

    const uploadShortfall = uploadedEntries.length < entries.length;
    const finalPartial = partial || uploadShortfall;
    const finalReason =
      [capReason, uploadShortfall ? "upload_incomplete" : null]
        .filter((value): value is string => Boolean(value))
        .join("+") || undefined;

    const manifest: DurableSnapshotManifest = {
      version: 1,
      workspaceId,
      atMs: Date.now(),
      partial: finalPartial,
      ...(finalReason ? { reason: finalReason } : {}),
      filesCount: uploadedEntries.length,
      totalBytes: uploadedEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      files: uploadedEntries,
    };
    // UN SEUL champ `durableSnapshot` sur le document de registre existant —
    // merge (aucun nouveau pattern d'écriture, politique quota Task 102).
    await registryDoc(workspaceId).set({ durableSnapshot: manifest }, { merge: true });
    rememberBounded(
      lastManifestSignatures,
      workspaceId,
      manifestSignature({ partial: finalPartial, reason: finalReason, files: uploadedEntries }),
    );
    return {
      ok: true,
      files: manifest.filesCount,
      bytes: manifest.totalBytes,
      ...(finalPartial && finalReason ? { reason: finalReason } : {}),
    };
  } catch (error) {
    console.warn(
      "[workspace] snapshot durable impossible (non bloquant):",
      error instanceof Error ? error.message : error,
    );
    return { ok: false, files: 0, bytes: 0, reason: "snapshot_failed" };
  }
}

/**
 * Fire-and-forget SÉCURISÉ : exécute le snapshot avec un timeout court (8 s
 * par défaut), coalesce les déclenchements simultanés d'un même workspace et
 * n'lève JAMAIS (erreurs loggées en console FR). Conçu pour être appelé en
 * `void snapshotWorkspaceSafe(id)` aux points de checkpoint, ou awaited quand
 * l'appelant peut se permettre d'attendre la borne.
 */
export async function snapshotWorkspaceSafe(workspaceId: string, timeoutMs = 8_000): Promise<void> {
  const pending = inFlightSnapshots.get(workspaceId);
  if (pending) {
    await pending;
    return;
  }
  const run = (async () => {
    const deadline = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    await Promise.race([snapshotWorkspaceToDurableStorage(workspaceId), deadline]);
  })().catch((error: unknown) => {
    console.warn(
      "[workspace] snapshot durable impossible (non bloquant):",
      error instanceof Error ? error.message : error,
    );
  });
  inFlightSnapshots.set(workspaceId, run);
  try {
    await run;
  } finally {
    inFlightSnapshots.delete(workspaceId);
  }
}

/* ------------------------------------------------------------------ */
/* REHYDRATE (R2 → répertoire local)                                   */
/* ------------------------------------------------------------------ */

/**
 * Restaure le contenu du workspace depuis R2 vers le répertoire local
 * DÉTERMINISTE (workspaceRootFor) — jamais destructif : un répertoire local
 * présent fait foi (état supposé plus récent que l'instantané).
 *
 * Chaque fichier téléchargé est VÉRIFIÉ (sha256) ; un écart → fichier exclu
 * avec raison. Restauration atomique : écriture dans un répertoire de
 * staging (mkdtemp 0700) puis rename en place. Ne lève JAMAIS.
 */
export async function rehydrateWorkspaceFromManifest(
  workspaceId: string,
  manifest: DurableSnapshotManifest,
): Promise<WorkspaceRehydrateResult> {
  const root = workspaceRootFor(workspaceId);
  const present = await fs
    .stat(root)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (present) {
    return { ok: true, restored: 0, reason: "already_present" };
  }

  // Validation défensive du manifeste persisté (chemins + caps).
  const candidates = (Array.isArray(manifest.files) ? manifest.files : [])
    .filter(
      (entry) =>
        entry &&
        typeof entry.path === "string" &&
        isSafeRestoreRelativePath(entry.path) &&
        typeof entry.sha256 === "string" &&
        entry.sha256.length === 64 &&
        typeof entry.r2Key === "string" &&
        entry.r2Key.length > 0,
    )
    .slice(0, WORKSPACE_SNAPSHOT_MAX_FILES);

  // Staging privé (0700) : la restauration n'est visible qu'une fois complète.
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "gen3ia-ws-restore-"));
  await fs.chmod(staging, 0o700);

  let restored = 0;
  let excluded = 0;
  let restoredBytes = 0;
  try {
    for (const entry of candidates) {
      // Cap bytes en restauration aussi (défense en profondeur).
      if (restoredBytes + (Number(entry.sizeBytes) || 0) > WORKSPACE_SNAPSHOT_MAX_BYTES) {
        excluded += 1;
        continue;
      }
      let buffer: Buffer;
      try {
        buffer = await downloadFromR2(entry.r2Key, WORKSPACE_SNAPSHOT_MAX_BYTES);
      } catch (error) {
        excluded += 1;
        console.warn(
          `[workspace] objet R2 illisible à la restauration (fichier exclu) : ${entry.path}`,
          error instanceof Error ? error.message : error,
        );
        continue;
      }
      if (sha256Hex(buffer) !== entry.sha256) {
        excluded += 1;
        console.warn(`[workspace] empreinte invalide à la restauration (fichier exclu) : ${entry.path}`);
        continue;
      }
      const target = path.join(staging, entry.path);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, buffer, { mode: 0o600 });
      restored += 1;
      restoredBytes += buffer.length;
    }

    if (candidates.length > 0 && restored === 0) {
      // Rien restauré : le répertoire reste ABSENT pour permettre une
      // nouvelle tentative ultérieure (et conserver l'ENOENT honnête).
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, restored: 0, reason: "restore_failed" };
    }

    if (restored > 0) {
      try {
        await fs.rename(staging, root);
      } catch {
        // Repli (course bénigne : répertoire créé entre-temps) : copie en place.
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        await fs.cp(staging, root, { recursive: true });
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    } else {
      // Manifeste sans fichier restaurable (workspace vide d'origine) :
      // un répertoire nu suffit.
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    console.warn(
      "[workspace] restauration impossible (non bloquant):",
      error instanceof Error ? error.message : error,
    );
    return { ok: false, restored: 0, reason: "restore_failed" };
  }

  // Estampille de reprise dans le registre (merge, fail-soft) : trace la
  // dernière restauration cross-instance sans changer de pattern d'écriture.
  await registryDoc(workspaceId)
    .set(
      { durableSnapshot: { ...manifest, lastRestoredAtMs: Date.now(), restoredCount: restored } },
      { merge: true },
    )
    .catch(() => undefined);

  if (restored > 0) {
    console.warn(
      `[workspace] reprise inter-instance restaurée depuis le stockage durable : ${restored} fichier(s) (workspace ${workspaceId})`,
    );
  }
  return {
    ok: true,
    restored,
    ...(excluded > 0 ? { reason: `excluded_files:${excluded}` } : {}),
  };
}

/** Reprise « publique » : lit le manifeste dans le registre puis restaure. */
export async function rehydrateWorkspaceFromDurableStorage(
  workspaceId: string,
): Promise<WorkspaceRehydrateResult> {
  if (!isR2Configured()) {
    return { ok: false, restored: 0, reason: "r2_unconfigured" };
  }
  let manifest: DurableSnapshotManifest | null = null;
  try {
    manifest = await readDurableSnapshot(workspaceId);
  } catch {
    manifest = null;
  }
  if (!manifest) {
    return { ok: false, restored: 0, reason: "no_durable_snapshot" };
  }
  return rehydrateWorkspaceFromManifest(workspaceId, manifest);
}

/**
 * Point d'entrée REPRISE (appelé par getWorkspace à chaque accès) : ne
 * restaure que si le répertoire local est ABSENT et qu'un manifeste existe ;
 * un échec arme un cooldown court pour ne pas marteler R2 à chaque appel.
 */
export async function rehydrateWorkspaceIfLocalMissing(
  workspaceId: string,
  manifest: DurableSnapshotManifest,
): Promise<WorkspaceRehydrateResult> {
  if (!isR2Configured()) {
    return { ok: false, restored: 0, reason: "r2_unconfigured" };
  }
  const cooldownUntil = rehydrateCooldownUntilMs.get(workspaceId);
  if (cooldownUntil && cooldownUntil > Date.now()) {
    return { ok: false, restored: 0, reason: "cooldown" };
  }
  const root = workspaceRootFor(workspaceId);
  const present = await fs
    .stat(root)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (present) {
    return { ok: true, restored: 0, reason: "already_present" };
  }
  const result = await rehydrateWorkspaceFromManifest(workspaceId, manifest);
  if (!result.ok) {
    rememberBounded(rehydrateCooldownUntilMs, workspaceId, Date.now() + REHYDRATE_COOLDOWN_MS);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* CHECKPOINT continu (sonde locale → snapshot fire-and-forget)        */
/* ------------------------------------------------------------------ */

/**
 * Sonde de changement appelée par getWorkspace (R2 configuré uniquement) :
 * readdir+stat plafonnés (~ms). Au changement de contenu → snapshot complet
 * fire-and-forget SÉCURISÉ (void, borné, coalescé, erreurs loggées) — jamais
 * bloquant pour l'appelant. C'est ce checkpoint continu qui rend les fichiers
 * écrits pendant une tranche de mission durables pour la tranche suivante.
 */
export async function probeAndSnapshotWorkspaceIfChanged(workspaceId: string): Promise<void> {
  if (!isR2Configured()) return; // production actuelle : AUCUN comportement ajouté
  try {
    const probe = await probeWorkspaceSignature(workspaceRootFor(workspaceId));
    if (probe.signature === "empty") {
      rememberBounded(lastProbeSignatures, workspaceId, probe.signature);
      return; // rien à préserver (répertoire absent ou vide)
    }
    const known = lastProbeSignatures.get(workspaceId);
    let changed = known !== probe.signature;
    // Sonde tronquée (> PROBE_MAX_ENTRIES) : les changements au-delà du
    // plafond sont invisibles → rafraîchissement forcé périodique.
    if (!changed && probe.truncated) {
      const last = lastTruncatedProbeAtMs.get(workspaceId) ?? 0;
      if (Date.now() - last > TRUNCATED_PROBE_MIN_INTERVAL_MS) {
        changed = true;
        rememberBounded(lastTruncatedProbeAtMs, workspaceId, Date.now());
      }
    }
    rememberBounded(lastProbeSignatures, workspaceId, probe.signature);
    if (changed) {
      void snapshotWorkspaceSafe(workspaceId);
    }
  } catch (error) {
    console.warn(
      "[workspace] sonde de checkpoint impossible (non bloquant):",
      error instanceof Error ? error.message : error,
    );
  }
}
