import "server-only";

/**
 * GEN3IA VIDEO AGENT — stockage objet organisé (canal R2 réel, spec §25).
 *
 * Layout : users/{userId}/video/{projectId}/{domaine}/fichier
 * avec domaines : script | storyboard | images | voice | music | sfx |
 * subtitles | renders | versions | thumbnails | tmp-uploads.
 *
 * Toutes les clés sont validées (préfixe propriétaire, pas de traversée)
 * avant tout accès — même logique de cloisonnement que permanent-user-storage.
 */

import { randomUUID } from "node:crypto";
import {
  uploadToR2,
  downloadFromR2,
  deleteFromR2,
  createDownloadUrl,
  listObjectsUnderPrefix,
} from "@/lib/storage/r2";

export const VIDEO_STORAGE_DOMAINS = [
  "script",
  "storyboard",
  "images",
  "voice",
  "music",
  "sfx",
  "subtitles",
  "renders",
  "versions",
  "thumbnails",
  "tmp-uploads",
] as const;
export type VideoStorageDomain = (typeof VIDEO_STORAGE_DOMAINS)[number];

export function videoProjectPrefix(userId: string, projectId: string): string {
  return `users/${userId}/video/${projectId}/`;
}

/** Construit une clé R2 vidéo validée — lève si le domaine est inconnu. */
export function videoObjectKey(params: {
  userId: string;
  projectId: string;
  domain: VideoStorageDomain;
  fileName?: string;
}): string {
  const { userId, projectId, domain } = params;
  const fileName = params.fileName ?? `${randomUUID()}`;
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
    throw new Error("Nom de fichier vidéo invalide (caractères autorisés : A-Z a-z 0-9 . _ -).");
  }
  return `${videoProjectPrefix(userId, projectId)}${domain}/${fileName}`;
}

/** Vérifie qu'une clé appartient bien au propriétaire (anti-traversée). */
export function isOwnedVideoKey(userId: string, key: string): boolean {
  return (
    typeof key === "string" &&
    key.startsWith(`users/${userId}/video/`) &&
    !key.includes("..") &&
    !key.includes("//")
  );
}

export async function uploadVideoAsset(params: {
  userId: string;
  projectId: string;
  domain: VideoStorageDomain;
  body: Buffer | Uint8Array;
  contentType: string;
  fileName?: string;
}): Promise<{ r2Key: string; sizeBytes: number }> {
  const r2Key = videoObjectKey({
    userId: params.userId,
    projectId: params.projectId,
    domain: params.domain,
    fileName: params.fileName,
  });
  await uploadToR2(r2Key, params.body, params.contentType);
  return { r2Key, sizeBytes: params.body.byteLength };
}

export async function downloadVideoAsset(userId: string, r2Key: string, maxBytes?: number): Promise<Buffer> {
  if (!isOwnedVideoKey(userId, r2Key)) {
    throw new Error("Accès refusé : clé vidéo hors du stockage propriétaire.");
  }
  return downloadFromR2(r2Key, maxBytes ?? 512 * 1024 * 1024);
}

/** URL de lecture présignée, réservée au propriétaire du projet. */
export async function createVideoPlaybackUrl(userId: string, r2Key: string, expiresInSec = 600): Promise<string> {
  if (!isOwnedVideoKey(userId, r2Key)) {
    throw new Error("Accès refusé : clé vidéo hors du stockage propriétaire.");
  }
  return createDownloadUrl(r2Key, expiresInSec);
}

export async function deleteVideoObject(userId: string, r2Key: string): Promise<void> {
  if (!isOwnedVideoKey(userId, r2Key)) {
    throw new Error("Accès refusé : clé vidéo hors du stockage propriétaire.");
  }
  await deleteFromR2(r2Key);
}

/** Liste les fichiers d'un domaine (bibliothèque média, nettoyage). */
export async function listVideoDomain(
  userId: string,
  projectId: string,
  domain: VideoStorageDomain,
  limit = 200,
): Promise<Array<{ key: string; sizeBytes: number; updatedAt: string }>> {
  return listObjectsUnderPrefix(`${videoProjectPrefix(userId, projectId)}${domain}/`, Math.min(Math.max(limit, 1), 500));
}

/** Purge complète d'un projet (suppression) — par lots de préfixe. */
export async function deleteProjectStorage(userId: string, projectId: string): Promise<number> {
  const objects = await listObjectsUnderPrefix(videoProjectPrefix(userId, projectId), 500);
  let deleted = 0;
  for (const object of objects) {
    await deleteFromR2(object.key);
    deleted += 1;
  }
  return deleted;
}

/**
 * Extraction d'un fichier temporaire local pour FFmpeg : les rendus ne
 * travaillent JAMAIS sur des URLs distantes (pas de SSRF possible) —
 * tout est téléchargé en amont dans le répertoire tmp du job.
 */
export async function materializeForRender(params: {
  userId: string;
  r2Key: string;
  tmpDir: string;
  fileName: string;
  maxBytes?: number;
}): Promise<string> {
  const buffer = await downloadVideoAsset(params.userId, params.r2Key, params.maxBytes);
  const { join, resolve } = await import("node:path");
  const { writeFile, mkdir } = await import("node:fs/promises");
  const safeName = params.fileName.replace(/[^A-Za-z0-9._-]/g, "_");
  const target = resolve(join(params.tmpDir, safeName));
  // Le chemin résolu doit rester DANS le tmp du job (anti-traversée locale).
  if (!target.startsWith(resolve(params.tmpDir))) {
    throw new Error("Chemin temporaire de rendu invalide.");
  }
  await mkdir(params.tmpDir, { recursive: true });
  await writeFile(target, buffer);
  return target;
}
