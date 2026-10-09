import { adminDb } from "@/lib/firebase/admin";
import { runFirestoreGuarded } from "@/lib/queue/firestore-guard";

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

/**
 * GARDE QUOTA (Task 110-e) : createArtifactRecord est l'écriture du LIVRABLE
 * de mission (outil artifact.create → storeArtifactBuffer, chemin runtime
 * AgentRuntime → executeToolSecurely). Sur Firestore brut, sous quota
 * quotidien épuisé l'écriture pendaît SANS lever (Task 97) : l'étape
 * livrable pendait jusqu'à son timeout (120 s par défaut) puis échouait —
 * le travail réalisé était perdu pour l'utilisateur. runFirestoreGuarded
 * borne l'écriture à 6 s + disjoncteur : échec rapide, quota-classifié,
 * mission finalisée honnêtement au lieu d'une pendule.
 */
export async function createArtifactRecord(
  artifact: ArtifactRecord,
): Promise<ArtifactRecord> {
  await runFirestoreGuarded(`artifact create ${artifact.artifactId}`, () => adminDb.collection(COLLECTION).doc(artifact.artifactId).create(artifact));
  return artifact;
}

export async function getArtifactRecord(
  artifactId: string,
): Promise<ArtifactRecord | null> {
  const snapshot = await runFirestoreGuarded(`artifact get ${artifactId}`, () => adminDb.collection(COLLECTION).doc(artifactId).get());
  if (!snapshot.exists) return null;
  return snapshot.data() as ArtifactRecord;
}

export async function deleteArtifactRecord(artifactId: string): Promise<void> {
  await runFirestoreGuarded(`artifact delete ${artifactId}`, () => adminDb.collection(COLLECTION).doc(artifactId).delete());
}
