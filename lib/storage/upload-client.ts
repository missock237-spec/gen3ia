"use client";

import { authFetch } from "@/lib/firebase/auth-client";
import {
  CHUNK_SIZE_BYTES,
  MAX_FILES_PER_BATCH,
  validateUploadBatch,
} from "@/lib/storage/upload-policy";

export type UploadItemStatus = "pending" | "uploading" | "done" | "error" | "cancelled";

export type UploadItem = {
  id: string;
  file: File;
  filename: string;
  sizeBytes: number;
  sentBytes: number;
  progress: number;
  status: UploadItemStatus;
  error?: string;
  uploadId?: string;
};

export type UploadedFile = {
  path: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
};

export type UploadBatchResult = {
  uploaded: UploadedFile[];
  failed: UploadItem[];
};

const CHUNK_RETRIES = 3;

function extractError(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const message = String((body as { error?: unknown }).error ?? "");
    if (message) return message;
  }
  return fallback;
}

async function jsonError(response: Response, fallback: string): Promise<string> {
  try { return extractError(await response.json(), fallback); } catch { return fallback; }
}

/**
 * Televerse un lot de fichiers vers le stockage permanent via l'API chunked :
 * session -> chunks (3 Mo) -> commit. Chaque requete reste sous la limite
 * serverless (~4,5 Mo), ce qui autorise des fichiers jusqu'a 100 Mo en
 * production Vercel. Les fichiers sont traites sequentiellement pour rester
 * doux avec les connexions mobiles ; les chunks disposent de 3 tentatives.
 */
export async function uploadPermanentFiles(
  files: File[],
  onProgress?: (items: UploadItem[]) => void,
  shouldAbort?: () => boolean,
): Promise<UploadBatchResult> {
  const items: UploadItem[] = files.map((file, index) => ({
    id: `${index}-${file.name}-${file.size}`,
    file,
    filename: file.name,
    sizeBytes: file.size,
    sentBytes: 0,
    progress: 0,
    status: "pending",
  }));

  const notify = () => onProgress?.(items.map((item) => ({ ...item })));

  // Pre-validation client (le serveur reste l'autorite finale).
  const validation = validateUploadBatch(
    files.map((file) => ({ filename: file.name, contentType: file.type || "", sizeBytes: file.size })),
  );
  if (!validation.ok) {
    for (const rejection of validation.rejections) {
      const item = items[rejection.index];
      if (item) { item.status = "error"; item.error = rejection.reason; }
    }
    // Rejet global (quota, taille de lot) : tous les fichiers encore en attente
    // recuperent la meme raison.
    items.forEach((item) => {
      if (item.status === "pending") { item.status = "error"; item.error = validation.rejections[0]?.reason ?? "Lot refuse."; }
    });
    notify();
    return { uploaded: [], failed: items.filter((item) => item.status === "error") };
  }

  // 1) Session serveur : validation finale + quota + quotas de lot.
  notify();
  let sessions: Array<{ uploadId: string; filename: string }> = [];
  try {
    const response = await authFetch("/api/storage/permanent/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: files.map((file) => ({ filename: file.name, contentType: file.type || "", sizeBytes: file.size })),
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(await jsonError(response, "Session de televersement refusee."));
    sessions = (body as { sessions?: Array<{ uploadId: string; filename: string }> }).sessions ?? [];
    if (sessions.length !== files.length) throw new Error("Le serveur n'a pas valide tous les fichiers du lot.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Session de televersement refusee.";
    items.forEach((item) => { if (item.status !== "done") { item.status = "error"; item.error = message; } });
    notify();
    return { uploaded: [], failed: items };
  }

  const uploaded: UploadedFile[] = [];
  const failed: UploadItem[] = [];

  // 2) Televersement chunk par chunk, fichier par fichier.
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const session = sessions[index];
    if (!item || !session) continue;
    if (shouldAbort?.()) { item.status = "cancelled"; failed.push(item); notify(); continue; }

    item.status = "uploading";
    item.uploadId = session.uploadId;
    notify();

    try {
      const chunksTotal = Math.max(1, Math.ceil(item.file.size / CHUNK_SIZE_BYTES));
      for (let chunkIndex = 0; chunkIndex < chunksTotal; chunkIndex += 1) {
        if (shouldAbort?.()) throw new Error("Televersement annule.");
        const start = chunkIndex * CHUNK_SIZE_BYTES;
        const blob = item.file.slice(start, Math.min(start + CHUNK_SIZE_BYTES, item.file.size));

        let lastError: Error | null = null;
        for (let attempt = 0; attempt < CHUNK_RETRIES; attempt += 1) {
          const response = await authFetch(
            `/api/storage/permanent/chunk?uploadId=${encodeURIComponent(session.uploadId)}&index=${chunkIndex}`,
            { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: blob },
          );
          if (response.ok) { lastError = null; break; }
          lastError = new Error(await jsonError(response, "Chunk refuse par le serveur."));
          if (response.status >= 500 && attempt < CHUNK_RETRIES - 1) {
            await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
            continue;
          }
          break;
        }
        if (lastError) throw lastError;

        item.sentBytes = Math.min(start + blob.size, item.file.size);
        item.progress = item.sentBytes / item.file.size;
        notify();
      }

      // 3) Commit : assemblage GCS + verification d'integrite.
      const commitResponse = await authFetch("/api/storage/permanent/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uploadId: session.uploadId }),
      });
      const commitBody = await commitResponse.json().catch(() => ({}));
      if (!commitResponse.ok) throw new Error(await jsonError(commitResponse, "Assemblage du fichier impossible."));

      const committed = (commitBody as { file?: UploadedFile }).file;
      item.status = "done";
      item.progress = 1;
      item.sentBytes = item.file.size;
      if (committed) uploaded.push(committed);
      else uploaded.push({ path: "", filename: item.filename, sizeBytes: item.sizeBytes, contentType: item.file.type || "application/octet-stream" });
      notify();
    } catch (error) {
      item.status = "error";
      item.error = error instanceof Error ? error.message : "Televersement impossible.";
      failed.push(item);
      notify();
      // Purge des chunks temporaires de ce fichier, sans bloquer le lot.
      if (item.uploadId) {
        void authFetch(`/api/storage/permanent/session?uploadId=${encodeURIComponent(item.uploadId)}`, { method: "DELETE" }).catch(() => undefined);
      }
    }
  }

  notify();
  return { uploaded, failed };
}

export const UPLOAD_LIMITS = { CHUNK_SIZE_BYTES, MAX_FILES_PER_BATCH };
