import { adminDb } from "@/lib/firebase/admin";

export interface ArtifactRecord {
  artifactId: string;
  ownerId: string;
  executionId: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  checksum: string;
  createdAt: number;
  expiresAt?: number;
  /**
   * Repli SANS R2 : contenu stocké directement en base (base64, ≤ 700 Ko).
   * Utilisé tant que les credentials R2 ne sont pas configurés — les
   * livrables (pptx, pdf, docx…) restent générés et téléchargeables.
   */
  inlineData?: string;
}

const COLLECTION = "artifacts";

export async function createArtifactRecord(
  artifact: ArtifactRecord,
): Promise<ArtifactRecord> {
  await adminDb.collection(COLLECTION).doc(artifact.artifactId).create(artifact);
  return artifact;
}

export async function getArtifactRecord(
  artifactId: string,
): Promise<ArtifactRecord | null> {
  const snapshot = await adminDb.collection(COLLECTION).doc(artifactId).get();
  if (!snapshot.exists) return null;
  return snapshot.data() as ArtifactRecord;
}

export async function deleteArtifactRecord(artifactId: string): Promise<void> {
  await adminDb.collection(COLLECTION).doc(artifactId).delete();
}
