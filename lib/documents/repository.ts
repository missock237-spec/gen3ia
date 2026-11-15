import { adminDb } from "@/lib/firebase/admin";
import type { DocumentData, Query } from "@/lib/r2fs";

/**
 * User-facing artifact repository.
 *
 * Backed by the `artifacts` Firestore collection written by
 * `lib/documents/artifact-store.ts`. Every read is scoped to the owner so
 * callers never need to enforce ownership themselves.
 */

const COLLECTION = "artifacts";
const MAX_LIST_RESULTS = 100;

export interface UserArtifactView {
  artifactId: string;
  userId: string;
  filename: string;
  format: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  executionId?: string;
  createdAt: string;
}

function formatFromName(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return extension;
}

function toView(id: string, data: DocumentData): UserArtifactView {
  const filename = String(data.name ?? data.filename ?? id);
  return {
    artifactId: String(data.artifactId ?? id),
    userId: String(data.ownerId ?? data.userId ?? ""),
    filename,
    format: String(data.format ?? formatFromName(filename)),
    mimeType: String(data.mimeType ?? "application/octet-stream"),
    sizeBytes: Number(data.size ?? data.sizeBytes ?? 0),
    storagePath: String(data.storageKey ?? data.storagePath ?? ""),
    executionId:
      typeof data.executionId === "string" && data.executionId
        ? data.executionId
        : undefined,
    createdAt: new Date(Number(data.createdAt ?? Date.now())).toISOString(),
  };
}

export async function listUserArtifacts(
  userId: string,
  projectId?: string,
): Promise<UserArtifactView[]> {
  if (!userId) throw new Error("userId is required.");

  let query: Query = adminDb
    .collection(COLLECTION)
    .where("ownerId", "==", userId);

  if (projectId) {
    query = query.where("executionId", "==", projectId);
  }

  const snapshot = await query
    .orderBy("createdAt", "desc")
    .limit(MAX_LIST_RESULTS)
    .get();

  return snapshot.docs.map((doc) => toView(doc.id, doc.data()));
}

export async function getArtifactById(
  userId: string,
  artifactId: string,
): Promise<UserArtifactView | null> {
  if (!userId) throw new Error("userId is required.");
  if (!artifactId || artifactId.length > 256) throw new Error("artifactId is invalid.");

  const snapshot = await adminDb.collection(COLLECTION).doc(artifactId).get();
  if (!snapshot.exists) return null;

  const artifact = toView(snapshot.id, snapshot.data() ?? {});
  if (artifact.userId !== userId) return null;

  return artifact;
}
