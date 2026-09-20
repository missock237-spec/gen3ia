import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import type { File as GcsFile } from "@google-cloud/storage";
import { adminDb, adminStorage } from "@/lib/firebase/admin";
import {
  CHUNK_SIZE_BYTES,
  COMPOSE_BATCH_SIZE,
  MAX_FILE_BYTES,
  MAX_USER_QUOTA_BYTES,
  SESSION_TTL_MS,
  chunkCountFor,
  sanitizeFilename,
  type ValidatedUploadIntent,
} from "@/lib/storage/upload-policy";

const bucket = () => adminStorage.bucket();
const FILES_COLLECTION = "permanentFiles";
const SESSIONS_COLLECTION = "storageUploads";

function safeName(name: string) {
  const cleaned = name.normalize("NFKC").replace(/[\\/\0]/g, "_").replace(/[^\p{L}\p{N}._ -]/gu, "_").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error("Invalid file name.");
  return cleaned.slice(0, 180);
}
function objectPath(userId: string, name: string) { return `users/${userId}/permanent/${randomUUID()}-${safeName(name)}`; }
function tmpPrefix(userId: string, uploadId: string) { return `users/${userId}/tmp/${uploadId}/`; }

/* ------------------------------------------------------------------ */
/* Stockage direct (piece jointe chat, capture camera, petit fichier)  */
/* ------------------------------------------------------------------ */

export async function storePermanentFile(params: { userId: string; filename: string; content: Buffer; contentType?: string; metadata?: Record<string, string> }) {
  if (!params.userId?.trim()) throw new Error("Permanent storage requires userId.");
  if (params.content.length === 0 || params.content.length > MAX_FILE_BYTES) throw new Error("File exceeds the permanent storage limit.");
  const path = objectPath(params.userId, params.filename);
  const file = bucket().file(path);
  await file.save(params.content, { resumable: params.content.length > 5 * 1024 * 1024, contentType: params.contentType || "application/octet-stream", metadata: { metadata: { userId: params.userId, originalName: safeName(params.filename), ...(params.metadata ?? {}) } }, validation: "crc32c" });
  return { path, filename: safeName(params.filename), sizeBytes: params.content.length, contentType: params.contentType || "application/octet-stream" };
}

export async function listPermanentFiles(userId: string, limit = 100) {
  const [files] = await bucket().getFiles({ prefix: `users/${userId}/permanent/`, maxResults: Math.min(Math.max(limit, 1), 500) });
  return Promise.all(files.map(async (file) => {
    const [metadata] = await file.getMetadata();
    return { path: file.name, filename: String(metadata.metadata?.originalName ?? file.name.split("/").pop()), sizeBytes: Number(metadata.size ?? 0), contentType: String(metadata.contentType ?? "application/octet-stream"), updatedAt: String(metadata.updated ?? "") };
  }));
}

export async function createPermanentDownloadUrl(userId: string, path: string) {
  if (!isOwnedPermanentPath(userId, path)) throw new Error("Invalid permanent storage path.");
  const [url] = await bucket().file(path).getSignedUrl({ action: "read", expires: Date.now() + 10 * 60 * 1000 });
  return url;
}

export async function deletePermanentFile(userId: string, path: string) {
  if (!isOwnedPermanentPath(userId, path)) throw new Error("Invalid permanent storage path.");
  await bucket().file(path).delete({ ignoreNotFound: true });
  // Nettoyage de la fiche metadonnee associee (televersements chunkes).
  const snap = await adminDb.collection(FILES_COLLECTION).where("userId", "==", userId).where("path", "==", path).limit(1).get();
  await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
}

function isOwnedPermanentPath(userId: string, path: string) {
  return typeof path === "string" && path.startsWith(`users/${userId}/permanent/`) && !path.includes("..");
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
/* Televersement chunké (fichiers jusqu'a 100 Mo via serverless)       */
/* ------------------------------------------------------------------ */

export type UploadSessionView = {
  uploadId: string;
  path: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  chunksTotal: number;
  chunkSizeBytes: number;
};

type SessionDoc = {
  userId: string;
  path: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  chunksTotal: number;
  receivedChunks: number[];
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
  const batch = adminDb.batch();

  for (const intent of params.intents) {
    const uploadId = randomUUID();
    const path = objectPath(params.userId, intent.safeFilename);
    const chunksTotal = chunkCountFor(intent.sizeBytes);
    const doc: SessionDoc = {
      userId: params.userId,
      path,
      filename: intent.safeFilename,
      contentType: intent.contentType || "application/octet-stream",
      sizeBytes: intent.sizeBytes,
      chunksTotal,
      receivedChunks: [],
      status: "active",
      createdAt: FieldValue.serverTimestamp() as unknown as SessionDoc["createdAt"],
    };
    batch.set(sessionRef(uploadId), doc);
    views.push({ uploadId, path, filename: intent.safeFilename, sizeBytes: intent.sizeBytes, contentType: doc.contentType, chunksTotal, chunkSizeBytes: CHUNK_SIZE_BYTES });
  }
  await batch.commit();
  return views;
}

/** Ecrit un chunk dans la zone temporaire GCS et l'enregistre dans la session. */
export async function recordChunk(params: { userId: string; uploadId: string; index: number; content: Buffer }) {
  const session = await loadOwnedSession(params.userId, params.uploadId);
  if (session.status !== "active") throw new Error("Cette session de televersement est déjà terminée.");
  if (!Number.isInteger(params.index) || params.index < 0 || params.index >= session.chunksTotal) throw new Error("Index de chunk invalide.");

  const isLast = params.index === session.chunksTotal - 1;
  const expectedSize = isLast ? session.sizeBytes - CHUNK_SIZE_BYTES * (session.chunksTotal - 1) : CHUNK_SIZE_BYTES;
  if (params.content.length !== expectedSize) {
    throw new Error(`Taille de chunk invalide (recu ${params.content.length} octets, attendu ${expectedSize}).`);
  }

  const tmpPath = `${tmpPrefix(params.userId, params.uploadId)}${String(params.index).padStart(6, "0")}`;
  await bucket().file(tmpPath).save(params.content, { resumable: false, contentType: "application/octet-stream", validation: "crc32c" });
  await sessionRef(params.uploadId).update({ receivedChunks: FieldValue.arrayUnion(params.index) });
  return { received: session.receivedChunks.length + 1, total: session.chunksTotal };
}

/** Assemble les chunks (GCS compose), finalise le fichier et ecrit la metadonnee. */
export async function commitUpload(params: { userId: string; uploadId: string }) {
  const session = await loadOwnedSession(params.userId, params.uploadId);

  if (session.status === "committed") {
    const existing = await adminDb.collection(FILES_COLLECTION).doc(params.uploadId).get();
    if (existing.exists) return permanentFileFromDoc(params.uploadId, existing);
    throw new Error("Session déjà finalisée mais metadonnée introuvable.");
  }
  if (session.status !== "active") throw new Error("Cette session de televersement a été annulée.");

  const received = [...new Set(session.receivedChunks)].sort((a, b) => a - b);
  if (received.length !== session.chunksTotal) {
    throw new Error(`Televersement incomplet : ${received.length}/${session.chunksTotal} chunks recus.`);
  }

  const tmp = tmpPrefix(params.userId, params.uploadId);
  const bucketRef = bucket();
  const chunkFiles = received.map((index) => bucketRef.file(`${tmp}${String(index).padStart(6, "0")}`));
  const destination = bucketRef.file(session.path);

  if (chunkFiles.length === 1) {
    await chunkFiles[0].rename(destination);
  } else {
    await composeIteratively(chunkFiles, destination, tmp);
  }

  // Verification d'integrite : la taille finale doit correspondre a la session.
  const [finalMetadata] = await destination.getMetadata();
  const finalSize = Number(finalMetadata.size ?? 0);
  if (finalSize !== session.sizeBytes) {
    await destination.delete({ ignoreNotFound: true });
    throw new Error(`Taille du fichier final incoherente (${finalSize} != ${session.sizeBytes}). Televersement annule.`);
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

  // Nettoyage des intermediaires eventuels + chunks restants (rename a deja
  // deplace le premier chunk dans le cas mono-chunk).
  await deleteUnderPrefix(params.userId, tmp);

  return {
    uploadId: params.uploadId,
    path: session.path,
    filename: session.filename,
    sizeBytes: session.sizeBytes,
    contentType: session.contentType,
  };
}

/** Compose iteratif par lots de 30 max (limite GCS : 32 composants). */
async function composeIteratively(chunkFiles: GcsFile[], destination: GcsFile, tmpPrefixPath: string) {
  const bucketRef = bucket();
  let level: string[] = chunkFiles.map((file) => file.name);
  let round = 0;
  while (level.length > 1) {
    const nextLevel: string[] = [];
    for (let offset = 0; offset < level.length; offset += COMPOSE_BATCH_SIZE) {
      const batchPaths = level.slice(offset, offset + COMPOSE_BATCH_SIZE);
      if (batchPaths.length === 1) { nextLevel.push(batchPaths[0]); continue; }
      const intermediatePath = `${tmpPrefixPath}compose-r${round}-${offset}`;
      await bucketRef.combine(batchPaths, intermediatePath);
      nextLevel.push(intermediatePath);
    }
    level = nextLevel;
    round += 1;
  }
  await bucketRef.file(level[0]).rename(destination);
}

/** Annule une session et supprime ses objets temporaires. */
export async function abortUpload(params: { userId: string; uploadId: string }) {
  const session = await loadOwnedSession(params.userId, params.uploadId);
  if (session.status === "active") {
    await deleteUnderPrefix(params.userId, tmpPrefix(params.userId, params.uploadId));
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

async function deleteUnderPrefix(userId: string, prefix: string) {
  const [files] = await bucket().getFiles({ prefix, maxResults: 500 });
  await Promise.all(files.map((file) => file.delete({ ignoreNotFound: true })));
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
 * listing GCS pour les fichiers depose via les flux legacy (chat, camera)
 * sans fiche metadonnee.
 */
export async function listPermanentFilesWithMetadata(userId: string): Promise<PermanentFileEntry[]> {
  const [filesSnap, legacyFiles] = await Promise.all([
    adminDb.collection(FILES_COLLECTION).where("userId", "==", userId).get(),
    listPermanentFiles(userId).catch(() => []),
  ]);

  const merged = new Map<string, PermanentFileEntry>();
  filesSnap.forEach((doc) => {
    const entry = permanentFileFromDoc(doc.id, doc);
    if (entry.path) merged.set(entry.path, entry);
  });
  for (const legacy of legacyFiles) {
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
  let deleted = 0;
  await Promise.all(snap.docs.map(async (doc) => {
    const createdAt = doc.get("createdAt");
    const createdMs = typeof createdAt?.toMillis === "function" ? createdAt.toMillis() : 0;
    if (createdMs > 0 && now - createdMs > SESSION_TTL_MS) {
      await deleteUnderPrefix(userId, tmpPrefix(userId, doc.id));
      await doc.ref.update({ status: "aborted" });
      deleted += 1;
    }
  }));
  return deleted;
}

export { sanitizeFilename };
