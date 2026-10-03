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
  await adminDb.collection(ASSETS_COLLECTION).doc(asset.id).create({ ...asset });
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
    await writeFile(path, body);
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
  const { FieldValue } = await import("firebase-admin/firestore");
  await adminDb.collection("videoProjects").doc(projectId).set(
    { stats: { assetCount: FieldValue.increment(1) }, updatedAt: nowIso() },
    { merge: true },
  );
}

export async function listAssets(userId: string, projectId: string, kind?: VideoAssetKind): Promise<VideoAsset[]> {
  const snap = await adminDb.collection(ASSETS_COLLECTION).where("userId", "==", userId).get();
  const assets = snap.docs
    .map((d) => d.data() as VideoAsset)
    .filter((a) => a.projectId === projectId && (!kind || a.kind === kind));
  assets.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return assets;
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
}

/** Met à jour les métadonnées média d'un asset (post-traitement). */
export async function patchAssetMedia(userId: string, assetId: string, media: MediaProbe): Promise<void> {
  const asset = await getAssetOrThrow(userId, assetId);
  await adminDb.collection(ASSETS_COLLECTION).doc(assetId).set({ media: { ...asset.media, ...media } }, { merge: true });
}
