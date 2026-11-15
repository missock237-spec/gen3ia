"use client";

import { authFetch } from "@/lib/firebase/auth-client";
import {
  MAX_FILES_PER_BATCH,
  PART_SIZE_BYTES,
  validateSingleUpload,
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

const PART_RETRIES = 3;

type SessionView = {
  uploadId: string;
  filename: string;
  partsTotal: number;
  partUrls: Array<{ partNumber: number; url: string }>;
};

function extractError(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const message = String((body as { error?: unknown }).error ?? "");
    if (message) return humanizeStorageError(message);
  }
  return fallback;
}

/**
 * Traduit une panne d'infrastructure de stockage en message ACTIONNABLE :
 * « R2 configuration is incomplete » (env serveur manquante) était renvoyé
 * tel quel — l'utilisateur ne savait ni ce qui cassait, ni que le reste de
 * la plateforme fonctionnait (audits 25-a/25-d : pièces jointes en panne
 * pour 100 % des comptes sans explication lisible).
 */
function humanizeStorageError(message: string): string {
  if (/R2 configuration|not configured|storage.*(incomplete|unavailable)/i.test(message)) {
    return (
      "Le stockage de fichiers est momentanément indisponible côté serveur. " +
      "Vos messages sans pièce jointe fonctionnent normalement — réessayez de joindre votre fichier plus tard."
    );
  }
  return message;
}

async function jsonError(response: Response, fallback: string): Promise<string> {
  try { return extractError(await response.json(), fallback); } catch { return fallback; }
}

/**
 * Televerse un lot de fichiers vers le stockage permanent via le flux
 * multipart a URLs presignees :
 *   1. session serveur (validation, quota, presignature des parties) ;
 *   2. le navigateur depose chaque partie (8 Mo) DIRECTEMENT chez R2 ;
 *   3. commit serveur (CompleteMultipartUpload + verification de taille).
 * Aucune donnee ne transite par la limite de corps serverless Vercel :
 * les fichiers jusqu'a 100 Mo passent en production.
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

  // Pre-validation client fichier par fichier (le serveur reste l'autorite
  // finale) : un fichier invalide est rejete seul, sans annuler le lot.
  if (files.length > MAX_FILES_PER_BATCH) {
    for (let index = MAX_FILES_PER_BATCH; index < items.length; index += 1) {
      items[index].status = "error";
      items[index].error = `Maximum ${MAX_FILES_PER_BATCH} fichiers par lot.`;
    }
  }
  const validIndexes: number[] = [];
  const validPayloads: Array<{ filename: string; contentType: string; sizeBytes: number }> = [];
  for (let index = 0; index < Math.min(files.length, MAX_FILES_PER_BATCH); index += 1) {
    const file = files[index];
    const verdict = validateSingleUpload({ filename: file.name, contentType: file.type || "", sizeBytes: file.size });
    if (verdict.ok) {
      validIndexes.push(index);
      validPayloads.push({ filename: file.name, contentType: file.type || "", sizeBytes: file.size });
    } else {
      items[index].status = "error";
      items[index].error = verdict.reason;
    }
  }
  notify();
  if (validIndexes.length === 0) {
    return { uploaded: [], failed: items.filter((item) => item.status === "error") };
  }

  // 1) Session serveur : validation finale + quota + URLs presignees.
  let sessions: SessionView[] = [];
  try {
    const response = await authFetch("/api/storage/permanent/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: validPayloads }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(await jsonError(response, "Session de televersement refusee."));
    sessions = (body as { sessions?: SessionView[] }).sessions ?? [];
    if (sessions.length !== validIndexes.length) throw new Error("Le serveur n'a pas valide tous les fichiers du lot.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Session de televersement refusee.";
    validIndexes.forEach((index) => {
      const item = items[index];
      if (item && item.status !== "done") { item.status = "error"; item.error = message; }
    });
    notify();
    return { uploaded: [], failed: items.filter((item) => item.status === "error") };
  }

  const uploaded: UploadedFile[] = [];
  const failed: UploadItem[] = [];

  // 2) Deposition des parties directement chez R2, fichier par fichier.
  for (let position = 0; position < validIndexes.length; position += 1) {
    const item = items[validIndexes[position]];
    const session = sessions[position];
    if (!item || !session) continue;
    if (shouldAbort?.()) { item.status = "cancelled"; failed.push(item); notify(); continue; }

    item.status = "uploading";
    item.uploadId = session.uploadId;
    notify();

    try {
      const parts: Array<{ partNumber: number; etag: string }> = [];
      for (const partUrl of session.partUrls) {
        if (shouldAbort?.()) throw new Error("Televersement annule.");
        const start = (partUrl.partNumber - 1) * PART_SIZE_BYTES;
        const blob = item.file.slice(start, Math.min(start + PART_SIZE_BYTES, item.file.size));

        let etag: string | null = null;
        let lastError: Error | null = null;
        for (let attempt = 0; attempt < PART_RETRIES; attempt += 1) {
          try {
            const response = await fetch(partUrl.url, { method: "PUT", body: blob });
            const header = response.headers.get("etag") ?? response.headers.get("ETag");
            if (response.ok && header) { etag = header.replace(/"/g, ""); break; }
            if (response.ok && !header) {
              throw new Error("Reponse R2 sans ETag : CORS du bucket a mettre a jour (ExposeHeaders).");
            }
            lastError = new Error(`Partie refusee par le stockage (${response.status}).`);
          } catch (error) {
            lastError = error instanceof Error ? error : new Error("Partie non deposee.");
          }
          if (attempt < PART_RETRIES - 1) {
            await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
          }
        }
        if (!etag) throw lastError ?? new Error("Partie non deposee.");

        parts.push({ partNumber: partUrl.partNumber, etag });
        item.sentBytes = Math.min(start + blob.size, item.file.size);
        item.progress = item.sentBytes / item.file.size;
        notify();
      }

      // 3) Commit : assemblage R2 + verification d'integrite.
      const commitResponse = await authFetch("/api/storage/permanent/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uploadId: session.uploadId, parts }),
      });
      const commitBody = await commitResponse.json().catch(() => ({}));
      if (!commitResponse.ok) throw new Error(await jsonError(commitResponse, "Assemblage du fichier impossible."));

      const committed = (commitBody as { file?: UploadedFile }).file;
      item.status = "done";
      item.progress = 1;
      item.sentBytes = item.file.size;
      uploaded.push(committed ?? { path: "", filename: item.filename, sizeBytes: item.sizeBytes, contentType: item.file.type || "application/octet-stream" });
      notify();
    } catch (error) {
      item.status = "error";
      item.error = error instanceof Error ? error.message : "Televersement impossible.";
      failed.push(item);
      notify();
      // Purge de l'upload multipart de ce fichier, sans bloquer le lot.
      if (item.uploadId) {
        void authFetch(`/api/storage/permanent/session?uploadId=${encodeURIComponent(item.uploadId)}`, { method: "DELETE" }).catch(() => undefined);
      }
    }
  }

  notify();
  return { uploaded, failed };
}

export const UPLOAD_LIMITS = { PART_SIZE_BYTES, MAX_FILES_PER_BATCH };
