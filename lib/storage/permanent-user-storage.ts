import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createDownloadUrl,
  createMultipartUpload,
  deleteFromR2,
  ensureBucketCors,
  listObjectsUnderPrefix,
  presignPartUpload,
  putObject,
} from "@/lib/storage/r2";
import {
  MAX_FILE_BYTES,
  MAX_USER_QUOTA_BYTES,
  PART_SIZE_BYTES,
  SESSION_TTL_MS,
  partCountFor,
  sanitizeFilename,
  type ValidatedUploadIntent,
} from "@/lib/storage/upload-policy";

const bucketName = () => process.env.R2_BUCKET || "gen3ia-artifacts";
const FILES_COLLECTION = "permanentFiles";
const SESSIONS_COLLECTION = "storageUploads";

function safeName(name: string) {
  const cleaned = name.normalize("NFKC").replace(/[\\/\0]/g, "_").replace(/[^\p{L}\p{N}._ -]/gu, "_").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error("Invalid file name.");
  return cleaned.slice(0, 180);
}
function objectKey(userId: string, name: string) { return `users/${userId}/permanent/${randomUUID()}-${safeName(name)}`; }

function isOwnedPermanentKey(userId: string, key: string) {
  return typeof key === "string" && key.startsWith(`users/${userId}/permanent/`) && !key.includes("..");
}

/* ------------------------------------------------------------------ */
/* Stockage direct (piece jointe chat, capture camera, petit fichier)  */
/* ------------------------------------------------------------------ */

export async function storePermanentFile(params: { userId: string; filename: string; content: Buffer; contentType?: string; metadata?: Record<string, string> }) {
  if (!params.userId?.trim()) throw new Error("Permanent storage requires userId.");
  if (params.content.length === 0 || params.content.length > MAX_FILE_BYTES) throw new Error("File exceeds the permanent storage limit.");
  const filename = safeName(params.filename);
  const key = objectKey(params.userId, params.filename);
  await putObject({ key, body: params.content, contentType: params.contentType || "application/octet-stream" });
  return { path: key, filename, sizeBytes: params.content.length, contentType: params.contentType || "application/octet-stream" };
}

export async function listPermanentFiles(userId: string, limit = 100) {
  const objects = await listObjectsUnderPrefix(`users/${userId}/permanent/`, Math.min(Math.max(limit, 1), 500));
  return objects.map((object) => ({
    path: object.key,
    filename: object.key.split("/").pop() ?? object.key,
    sizeBytes: object.sizeBytes,
    contentType: "application/octet-stream",
    updatedAt: object.updatedAt,
  }));
}

export async function createPermanentDownloadUrl(userId: string, path: string) {
  if (!isOwnedPermanentKey(userId, path)) throw new Error("Invalid permanent storage path.");
  return createDownloadUrl(path, 600);
}

export async function deletePermanentFile(userId: string, path: string) {
  if (!isOwnedPermanentKey(userId, path)) throw new Error("Invalid permanent storage path.");
  await deleteFromR2(path);
  const snap = await adminDb.collection(FILES_COLLECTION).where("userId", "==", userId).where("path", "==", path).limit(1).get();
  await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
}

/* ------------------------------------------------------------------ */
/* Quota                                                               */
/* ------------------------------------------------------------------ */

export type StorageUsage = { usedBytes: number; quotaBytes: number; fileCount: number };

export async function getUserStorageUsage(userId: string): Promise<StorageUsage> {
  const [filesSnap, sessionsSnap] = await Promise.all([
    adminDb.collection(FILES_COLLECTION).where("userId", "==", userId).get(),
    adminDb.collection(SESSIONS_COLLECTION).where("userId", "==", userId).where("status", "==", "active").get(),
  ]);
  let usedBytes = 0;
  filesSnap.forEach((doc) => { usedBytes += Number(doc.get("sizeBytes") ?? 0); });
  sessionsSnap.forEach((doc) => { usedBytes += Number(doc.get("sizeBytes") ?? 0); });
  return { usedBytes, quotaBytes: MAX_USER_QUOTA_BYTES, fileCount: filesSnap.size };
}

/* ------------------------------------------------------------------ */
/* Televersement multipart (fichiers jusqu'a 100 Mo)                   */
/*                                                                     */
/* Le serveur ouvre un upload multipart R2 et presigne une URL par     */
/* partie : le navigateur depose les donnees DIRECTEMENT chez R2, sans */
/* transiter par la limite de corps serverless (~4,5 Mo). Le commit    */
/* assemble l'objet cote R2 (CompleteMultipartUpload).                 */
/* ------------------------------------------------------------------ */

export type UploadSessionView = {
  uploadId: string;
  path: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  partsTotal: number;
  partSizeBytes: number;
  partUrls: Array<{ partNumber: number; url: string }>;
};

type SessionDoc = {
  userId: string;
  path: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  partsTotal: number;
  r2Key: string;
  r2UploadId: string;
  status: "active" | "committed" | "aborted";
  createdAt: FirebaseFirestore.Timestamp | Date | null;
};

function sessionRef(uploadId: string) { return adminDb.collection(SESSIONS_COLLECTION).doc(uploadId); }

/**
 * Ouvre une session de televersement par fichier valide. Le quota est
 * verifie sur l'usage existant + le total du lot afin de bloquer les
 * depassements des l'ouverture de session.
 */
export async function createUploadSessions(params: { userId: string; intents: ValidatedUploadIntent[] }): Promise<UploadSessionView[]> {
  const usage = await getUserStorageUsage(params.userId);
  if (usage.usedBytes + params.intents.reduce((sum, intent) => sum + intent.sizeBytes, 0) > MAX_USER_QUOTA_BYTES) {
    throw new Error("Quota de stockage depasse. Supprimez des fichiers ou reduisez le lot.");
  }

  const views: UploadSessionView[] = [];

  for (const intent of params.intents) {
    const uploadId = randomUUID();
    const key = objectKey(params.userId, intent.safeFilename);
    const contentType = intent.contentType || "application/octet-stream";
    const r2UploadId = await createMultipartUpload(key, contentType);
    const partsTotal = partCountFor(intent.sizeBytes);
    const partUrls: Array<{ partNumber: number; url: string }> = [];
    for (let partNumber = 1; partNumber <= partsTotal; partNumber += 1) {
      partUrls.push({ partNumber, url: await presignPartUpload(key, r2UploadId, partNumber) });
    }
    const doc: SessionDoc = {
      userId: params.userId,
      path: key,
      filename: intent.safeFilename,
      contentType,
      sizeBytes: intent.sizeBytes,
      partsTotal,
      r2Key: key,
      r2UploadId,
      status: "active",
      createdAt: FieldValue.serverTimestamp() as unknown as SessionDoc["createdAt"],
    };
    await sessionRef(uploadId).set(doc);
    views.push({ uploadId, path: key, filename: intent.safeFilename, sizeBytes: intent.sizeBytes, contentType, partsTotal, partSizeBytes: PART_SIZE_BYTES, partUrls });
  }
  return views;
}

/**
 * Finalise un fichier : assemble les pieces chez R2, verifie la taille
 * reelle et enregistre la metadonnee.
 */
export async function commitUpload(params: { userId: string; uploadId: string; parts: Array<{ partNumber: number; etag: string }> }) {
  const session = await loadOwnedSession(params.userId, params.uploadId);

  if (session.status === "committed") {
    const existing = await adminDb.collection(FILES_COLLECTION).doc(params.uploadId).get();
    if (existing.exists) return permanentFileFromDoc(params.uploadId, existing);
    throw new Error("Session déjà finalisée mais metadonnée introuvable.");
  }
  if (session.status !== "active") throw new Error("Cette session de televersement a été annulée.");

  const cleanParts = params.parts
    .filter((part) => Number.isInteger(part.partNumber) && part.partNumber >= 1 && part.partNumber <= session.partsTotal && typeof part.etag === "string" && part.etag.length > 0)
    .map((part) => ({ partNumber: part.partNumber, etag: part.etag.replace(/"/g, "") }));
  const uniqueParts = [...new Map(cleanParts.map((part) => [part.partNumber, part])).values()].sort((a, b) => a.partNumber - b.partNumber);
  if (uniqueParts.length !== session.partsTotal) {
    throw new Error(`Televersement incomplet : ${uniqueParts.length}/${session.partsTotal} parties recues.`);
  }

  const completed = await completeMultipartUpload(session.r2Key, session.r2UploadId, uniqueParts);
  if (completed.sizeBytes !== session.sizeBytes) {
    await deleteFromR2(session.r2Key);
    throw new Error(`Taille du fichier final incoherente (${completed.sizeBytes} != ${session.sizeBytes}). Televersement annule.`);
  }

  const metadataDoc = {
    userId: params.userId,
    path: session.path,
    filename: session.filename,
    sizeBytes: session.sizeBytes,
    contentType: session.contentType,
    createdAt: FieldValue.serverTimestamp(),
    source: "memory",
  };
  await adminDb.collection(FILES_COLLECTION).doc(params.uploadId).set(metadataDoc);
  await sessionRef(params.uploadId).update({ status: "committed" });

  return {
    uploadId: params.uploadId,
    path: session.path,
    filename: session.filename,
    sizeBytes: session.sizeBytes,
    contentType: session.contentType,
  };
}

/** Annule une session et libere l'upload multipart R2. */
export async function abortUpload(params: { userId: string; uploadId: string }) {
  const session = await loadOwnedSession(params.userId, params.uploadId);
  if (session.status === "active") {
    await abortMultipartUpload(session.r2Key, session.r2UploadId).catch(() => undefined);
    await sessionRef(params.uploadId).update({ status: "aborted" });
  }
}

async function loadOwnedSession(userId: string, uploadId: string) {
  if (!uploadId || /[^a-f0-9-]/i.test(uploadId)) throw new Error("Identifiant de session invalide.");
  const snap = await sessionRef(uploadId).get();
  if (!snap.exists) throw new Error("Session de televersement introuvable.");
  const data = snap.data() as SessionDoc | undefined;
  if (!data || data.userId !== userId) throw new Error("Session de televersement introuvable.");
  return data;
}

/* ------------------------------------------------------------------ */
/* Liste fusionnee (metadonnees + fichiers legacy)                     */
/* ------------------------------------------------------------------ */

export type PermanentFileEntry = {
  path: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  uploadedAt: string;
  source: "memory" | "legacy";
};

function permanentFileFromDoc(uploadId: string, doc: FirebaseFirestore.DocumentSnapshot): PermanentFileEntry {
  const createdAt = doc.get("createdAt");
  const uploadedAt = typeof createdAt?.toMillis === "function" ? new Date(createdAt.toMillis()).toISOString() : String(createdAt ?? new Date().toISOString());
  return {
    path: String(doc.get("path")),
    filename: String(doc.get("filename") ?? "fichier"),
    sizeBytes: Number(doc.get("sizeBytes") ?? 0),
    contentType: String(doc.get("contentType") ?? "application/octet-stream"),
    uploadedAt,
    source: "memory",
  };
}

/**
 * Liste authoritative : les metadonnees Firestore d'abord, completee par le
 * listing R2 pour les fichiers depose via les flux legacy (chat, camera)
 * sans fiche metadonnee.
 */
export async function listPermanentFilesWithMetadata(userId: string): Promise<PermanentFileEntry[]> {
  const [filesSnap, legacyObjects] = await Promise.all([
    adminDb.collection(FILES_COLLECTION).where("userId", "==", userId).get(),
    listPermanentFiles(userId).catch(() => []),
  ]);

  const merged = new Map<string, PermanentFileEntry>();
  filesSnap.forEach((doc) => {
    const entry = permanentFileFromDoc(doc.id, doc);
    if (entry.path) merged.set(entry.path, entry);
  });
  for (const legacy of legacyObjects) {
    if (!merged.has(legacy.path)) {
      merged.set(legacy.path, {
        path: legacy.path,
        filename: legacy.filename || legacy.path.split("/").pop() || "fichier",
        sizeBytes: legacy.sizeBytes,
        contentType: legacy.contentType,
        uploadedAt: legacy.updatedAt ? new Date(legacy.updatedAt).toISOString() : new Date(0).toISOString(),
        source: "legacy",
      });
    }
  }
  return [...merged.values()].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

/** Supprime les sessions expirees d'un utilisateur (appel opportuniste). */
export async function cleanupExpiredSessions(userId: string): Promise<number> {
  const snap = await adminDb.collection(SESSIONS_COLLECTION).where("userId", "==", userId).where("status", "==", "active").get();
  const now = Date.now();
  let cleaned = 0;
  for (const doc of snap.docs) {
    const createdAt = doc.get("createdAt");
    const createdMs = typeof createdAt?.toMillis === "function" ? createdAt.toMillis() : 0;
    if (createdMs > 0 && now - createdMs > SESSION_TTL_MS) {
      const data = doc.data() as SessionDoc;
      await abortMultipartUpload(data.r2Key, data.r2UploadId).catch(() => undefined);
      await doc.ref.update({ status: "aborted" });
      cleaned += 1;
    }
  }
  return cleaned;
}

/** Bootstrap unique : bucket + CORS pour le televersement direct. */
export async function bootstrapBucketCors(allowedOrigins: string[]) {
  return ensureBucketCors(allowedOrigins);
}

export { sanitizeFilename, bucketName };
