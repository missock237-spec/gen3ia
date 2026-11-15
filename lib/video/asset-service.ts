import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 10 : Media Library (gestion des assets).
 *
 * Chaque média (image générée, vidéo importée, narration, musique, SFX,
 * enregistrement vocal, sous-titres) est un document `videoAsset` lié au
 * projet, stocké dans R2 sous le domaine adapté, sondé par ffprobe à
 * l'enregistrement (durée, dimensions, présence audio) pour alimenter la
 * timeline avec des données réelles.
 */

import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import type { MediaProbe, VideoAsset, VideoAssetKind } from "@/lib/video/types";
import { uploadVideoAsset, deleteVideoObject, isOwnedVideoKey, downloadVideoAsset } from "@/lib/video/storage";
import { probeMedia } from "@/lib/video/ffmpeg";
import { assertMediaTypeAllowed, assertMediaSizeAllowed } from "@/lib/video/security";
import { mapWithConcurrency } from "@/lib/video/concurrency";

export const ASSETS_COLLECTION = "videoAssets";

function nowIso(): string {
  return new Date().toISOString();
}

const DOMAIN_BY_KIND: Record<VideoAssetKind, Parameters<typeof uploadVideoAsset>[0]["domain"]> = {
  image: "images",
  video: "renders",
  audio_narration: "voice",
  audio_music: "music",
  audio_sfx: "sfx",
  audio_voice_profile: "voice",
  subtitle: "subtitles",
  document: "script",
};

export interface RegisterAssetInput {
  userId: string;
  projectId: string;
  kind: VideoAssetKind;
  label: string;
  role?: string;
  sceneId?: string;
  origin?: VideoAsset["origin"];
  contentType: string;
  body: Buffer;
  /** Sonde ffprobe activée par défaut pour les médias audio/vidéo. */
  probe?: boolean;
}

/**
 * Enregistre un média : validation (MIME + taille), upload R2, sonde
 * ffprobe réelle, document Firestore. Un seul point d'entrée pour toutes
 * les sources (généré, uploadé, enregistrement, bibliothèque).
 */
export async function registerAsset(input: RegisterAssetInput): Promise<VideoAsset> {
  const mediaKind =
    input.kind === "image" ? "image"
    : input.kind === "video" ? "video"
    : input.kind.startsWith("audio_") ? "audio"
    : null;
  if (mediaKind) {
    assertMediaTypeAllowed(mediaKind, input.contentType);
    assertMediaSizeAllowed(input.body.byteLength, mediaKind);
  }

  const fileName = `${randomUUID()}${extensionFor(input.contentType, input.kind)}`;
  const { r2Key, sizeBytes } = await uploadVideoAsset({
    userId: input.userId,
    projectId: input.projectId,
    domain: DOMAIN_BY_KIND[input.kind],
    body: input.body,
    contentType: input.contentType,
    fileName,
  });

  let media: MediaProbe | undefined;
  if (input.probe !== false && (mediaKind === "audio" || mediaKind === "video")) {
    media = await probeBuffer(input.body, input.contentType);
  }

  const asset: VideoAsset = {
    id: randomUUID(),
    projectId: input.projectId,
    userId: input.userId,
    kind: input.kind,
    role: input.role,
    label: input.label,
    r2Key,
    contentType: input.contentType,
    sizeBytes,
    media,
    origin: input.origin ?? "uploaded",
    sceneId: input.sceneId,
    createdAt: nowIso(),
  };
  // Task 159 — doc D'ABORD, index ENSUITE : l'index ne peut référencer un
  // doc absent que le temps d'un échec (annulé par le retrait best-effort
  // ci-dessous) ; listAssets élague de toute façon les résidus (doc disparu).
  await adminDb.collection(ASSETS_COLLECTION).doc(asset.id).create({ ...asset });
  try {
    await upsertAssetIndexEntry(input.userId, input.projectId, asset.id, entryOf(asset));
  } catch (error) {
    // État incohérent interdit : l'asset serait invisible des lectures.
    await adminDb.collection(ASSETS_COLLECTION).doc(asset.id).delete().catch(() => undefined);
    throw error;
  }
  await bumpAssetCount(input.projectId);
  return asset;
}

/** Sonde sur buffer : écrit dans un fichier temporaire pour ffprobe. */
async function probeBuffer(body: Buffer, contentType: string): Promise<MediaProbe | undefined> {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "gen3ia-probe-"));
  try {
    const ext = contentType.includes("wav") ? ".wav" : contentType.includes("mp4") || contentType.includes("m4a") ? ".mp4" : contentType.includes("webm") ? ".webm" : contentType.includes("mpeg") ? ".mp3" : contentType.includes("ogg") ? ".ogg" : contentType.includes("flac") ? ".flac" : ".bin";
    const path = join(dir, `probe${ext}`);
    // Durcissement CodeQL js/http-to-file-access (#68) : le buffer provient
    // d'un média téléversé ; la sonde ffprobe exige une matérialisation
    // fichier (sandbox FFmpeg protocoles file,pipe uniquement —
    // fonctionnalité voulue). L'écriture est durcie : création EXCLUSIVE
    // (flag « wx » → échoue si le nom existe déjà) en mode 0600, dans un
    // répertoire mkdtemp 0700 imprévisible et instance-local, sous un nom
    // fixe créé par ce seul processus, répertoire supprimé en finally.
    await writeFile(path, body, { flag: "wx", mode: 0o600 });
    return await probeMedia(path, dir);
  } catch {
    return undefined; // fail-soft : l'asset reste exploitable, sans métadonnées
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function extensionFor(contentType: string, kind: VideoAssetKind): string {
  const map: Record<string, string> = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
    "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/wav": ".wav",
    "audio/x-wav": ".wav", "audio/webm": ".webm", "audio/ogg": ".ogg",
    "audio/opus": ".opus", "audio/flac": ".flac",
  };
  if (map[contentType]) return map[contentType];
  if (kind === "subtitle") return ".ass";
  if (kind === "document") return ".json";
  return "";
}

async function bumpAssetCount(projectId: string): Promise<void> {
  const { FieldValue } = await import("@/lib/r2fs");
  await adminDb.collection("videoProjects").doc(projectId).set(
    { stats: { assetCount: FieldValue.increment(1) }, updatedAt: nowIso() },
    { merge: true },
  );
}

export async function listAssets(userId: string, projectId: string, kind?: VideoAssetKind): Promise<VideoAsset[]> {
  const index = await ensureAssetIndex(userId, projectId);
  const ids = Object.entries(index.entries)
    .filter(([, entry]) => !kind || entry.k === kind)
    .sort(([, a], [, b]) => (a.c < b.c ? 1 : -1))
    .map(([id]) => id);

  // Lecture des SEULS docs du projet (fini le scan « toute la collection,
  // tous utilisateurs confondus »), concurrence bornée, élagage des ids
  // référençant des docs disparus (auto-réparation de l'index).
  const outcomes = await mapWithConcurrency(ids, 10, (id) =>
    adminDb.collection(ASSETS_COLLECTION).doc(id).get());
  const pruned: string[] = [];
  const assets: VideoAsset[] = [];
  outcomes.forEach((outcome, i) => {
    const snap = outcome.status === "fulfilled" ? outcome.value : null;
    if (!snap || !snap.exists) {
      pruned.push(ids[i]);
      return;
    }
    const asset = snap.data() as VideoAsset;
    if (asset.userId === userId && asset.projectId === projectId) assets.push(asset);
  });
  if (pruned.length > 0) {
    await removeFromAssetIndex(userId, projectId, pruned).catch(() => undefined);
  }
  assets.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return assets;
}

/**
 * Compte les assets GÉNÉRÉS d'un kind pour le projet — SANS LIRE AUCUN
 * document : l'index porte (kind, origin). Remplace les scans utilisateur
 * complet des plafonds images/clips (spec §28) par 1 lecture d'index.
 */
export async function countGeneratedProjectAssets(
  userId: string,
  projectId: string,
  kind: VideoAssetKind,
): Promise<number> {
  const index = await ensureAssetIndex(userId, projectId);
  return Object.values(index.entries).filter((e) => e.k === kind && e.o === "generated").length;
}

export async function getAsset(userId: string, assetId: string): Promise<VideoAsset | null> {
  const snap = await adminDb.collection(ASSETS_COLLECTION).doc(assetId).get();
  if (!snap.exists) return null;
  const asset = snap.data() as VideoAsset;
  if (asset.userId !== userId) return null;
  return asset;
}

export async function getAssetOrThrow(userId: string, assetId: string): Promise<VideoAsset> {
  const asset = await getAsset(userId, assetId);
  if (!asset) throw new Error(`Asset introuvable : ${assetId}`);
  return asset;
}

/** Télécharge le contenu d'un asset (worker de rendu uniquement). */
export async function downloadAssetContent(userId: string, asset: VideoAsset): Promise<Buffer> {
  if (!isOwnedVideoKey(userId, asset.r2Key)) throw new Error("Clé d'asset hors stockage propriétaire.");
  return downloadVideoAsset(userId, asset.r2Key);
}

export async function deleteAsset(userId: string, assetId: string): Promise<void> {
  const asset = await getAssetOrThrow(userId, assetId);
  await deleteVideoObject(userId, asset.r2Key);
  await adminDb.collection(ASSETS_COLLECTION).doc(assetId).delete();
  // Best-effort : si le retrait échoue, l'entrée référence un doc disparu —
  // la prochaine lecture l'élimine (auto-réparation).
  await removeFromAssetIndex(userId, asset.projectId, [assetId]).catch(() => undefined);
}

/** Met à jour les métadonnées média d'un asset (post-traitement). */
export async function patchAssetMedia(userId: string, assetId: string, media: MediaProbe): Promise<void> {
  const asset = await getAssetOrThrow(userId, assetId);
  await adminDb.collection(ASSETS_COLLECTION).doc(assetId).set({ media: { ...asset.media, ...media } }, { merge: true });
}

// ────────────────────────────────────────────────────────────────────────────
// Task 159 — INDEX PAR PROJET (efficacité). Chaque requête r2fs = scan de
// collection + téléchargement des documents (plafond 2000 docs, cf. db.ts).
// Les 19 points d'appel de listAssets sont TOUS bornés (userId, projectId) :
// un index documentaire par projet réduit chaque lecture de « TOUTE la
// collection videoAssets — tous utilisateurs — en 2 pages de listing +
// jusqu'à 2000 GET » à « 1 doc d'index + les assets du projet ». Les compteurs
// de plafond (images/clips générés) ne lisent PLUS AUCUN document : l'index
// porte (kind, origin, createdAt) par asset.
//
// Cohérence : doc créé PUIS indexé (jamais l'inverse) — l'index ne peut pas
// référencer durablement un doc absent ; les résidus sont élagués à la
// lecture. L'index absent (données antérieures) est reconstruit par le scan
// historique UNE fois, en fusion concurrente (aucune perte).
// ────────────────────────────────────────────────────────────────────────────

const ASSET_INDEX_COLLECTION = "videoAssetIndex";

interface AssetIndexEntry {
  /** kind — filtrage sans lecture du doc. */
  k: VideoAssetKind;
  /** origin — comptage des générés sans lecture du doc. */
  o: VideoAsset["origin"];
  /** createdAt — tri sans lecture du doc. */
  c: string;
}

interface AssetIndexData {
  userId: string;
  projectId: string;
  entries: Record<string, AssetIndexEntry>;
  updatedAt: string;
}

/** Id de doc d'index : segments sûrs r2fs ([A-Za-z0-9._-]), séparateur « __ ». */
function assetIndexDocId(userId: string, projectId: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe(userId)}__${safe(projectId)}`;
}

function entryOf(asset: Pick<VideoAsset, "kind" | "origin" | "createdAt">): AssetIndexEntry {
  return { k: asset.kind, o: asset.origin ?? "uploaded", c: asset.createdAt };
}

async function readAssetIndex(userId: string, projectId: string): Promise<AssetIndexData | null> {
  const snap = await adminDb.collection(ASSET_INDEX_COLLECTION).doc(assetIndexDocId(userId, projectId)).get();
  if (!snap.exists) return null;
  const data = snap.data() as Partial<AssetIndexData> | undefined;
  if (!data || typeof data.entries !== "object" || data.entries === null) return null;
  return { userId, projectId, entries: data.entries as Record<string, AssetIndexEntry>, updatedAt: data.updatedAt ?? nowIso() };
}

/** Ajoute (ou met à jour) l'entrée d'un asset — transaction CAS (conflits rejoués). */
async function upsertAssetIndexEntry(
  userId: string,
  projectId: string,
  assetId: string,
  entry: AssetIndexEntry,
): Promise<void> {
  await adminDb.runTransaction(async (tx) => {
    const ref = adminDb.collection(ASSET_INDEX_COLLECTION).doc(assetIndexDocId(userId, projectId));
    const snap = await tx.get(ref);
    const existing = snap.exists ? ((snap.data() as Partial<AssetIndexData>)?.entries ?? {}) : {};
    tx.set(ref, {
      userId,
      projectId,
      entries: { ...existing, [assetId]: entry },
      updatedAt: nowIso(),
    });
  });
}

/** Retire des ids de l'index (idempotent, transaction CAS). */
async function removeFromAssetIndex(userId: string, projectId: string, assetIds: string[]): Promise<void> {
  if (assetIds.length === 0) return;
  await adminDb.runTransaction(async (tx) => {
    const ref = adminDb.collection(ASSET_INDEX_COLLECTION).doc(assetIndexDocId(userId, projectId));
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const existing = ((snap.data() as Partial<AssetIndexData>)?.entries ?? {}) as Record<string, AssetIndexEntry>;
    let changed = false;
    for (const id of assetIds) {
      if (existing[id]) {
        delete existing[id];
        changed = true;
      }
    }
    if (changed) {
      tx.set(ref, { userId, projectId, entries: existing, updatedAt: nowIso() });
    }
  });
}

/**
 * Reconstruit l'index par le scan historique (migration des données
 * antérieures) puis le persiste. Fusion concurrente : si l'index a été créé
 * entre-temps, les entrées sont unies (aucune perte).
 */
async function backfillAssetIndex(userId: string, projectId: string): Promise<AssetIndexData> {
  const snap = await adminDb.collection(ASSETS_COLLECTION).where("userId", "==", userId).get();
  const entries: Record<string, AssetIndexEntry> = {};
  for (const doc of snap.docs) {
    const data = doc.data() as VideoAsset;
    if (data?.projectId !== projectId) continue;
    entries[doc.id] = entryOf(data);
  }
  await adminDb.runTransaction(async (tx) => {
    const ref = adminDb.collection(ASSET_INDEX_COLLECTION).doc(assetIndexDocId(userId, projectId));
    const current = await tx.get(ref);
    const existing = current.exists ? ((current.data() as Partial<AssetIndexData>)?.entries ?? {}) : {};
    tx.set(ref, { userId, projectId, entries: { ...existing, ...entries }, updatedAt: nowIso() });
  });
  return { userId, projectId, entries, updatedAt: nowIso() };
}

/** Index du projet — lecture, ou reconstruction par scan historique si absent. */
async function ensureAssetIndex(userId: string, projectId: string): Promise<AssetIndexData> {
  const existing = await readAssetIndex(userId, projectId);
  return existing ?? backfillAssetIndex(userId, projectId);
}
