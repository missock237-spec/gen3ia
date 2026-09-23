import "server-only";

import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import type { ArtifactType, ArtifactVersion, ConversationArtifact } from "@/lib/domain/conversations/types";

/**
 * Artifact — livrable standardisé produit par une conversation ou un run :
 * code, document, tableau, image, rapport ou fichier téléchargeable.
 * Chaque artefact porte ses versions (revenir à une version précédente).
 */

const COLLECTION = "conversationArtifacts";

export const ARTIFACT_TYPES: readonly ArtifactType[] = ["code", "document", "table", "image", "report", "file"];

export function isArtifactType(value: string): value is ArtifactType {
  return (ARTIFACT_TYPES as readonly string[]).includes(value);
}

function docFrom(id: string, data: FirebaseFirestore.DocumentData): ConversationArtifact {
  const versions = Array.isArray(data.versions) ? (data.versions as ArtifactVersion[]) : [];
  return {
    id,
    userId: String(data.userId ?? ""),
    conversationId: typeof data.conversationId === "string" ? data.conversationId : undefined,
    projectId: typeof data.projectId === "string" ? data.projectId : undefined,
    runId: typeof data.runId === "string" ? data.runId : undefined,
    type: (isArtifactType(String(data.type)) ? data.type : "file") as ArtifactType,
    title: String(data.title ?? "Artefact"),
    language: typeof data.language === "string" ? data.language : undefined,
    filename: typeof data.filename === "string" ? data.filename : undefined,
    content: typeof data.content === "string" ? data.content : undefined,
    storagePath: typeof data.storagePath === "string" ? data.storagePath : undefined,
    url: typeof data.url === "string" ? data.url : undefined,
    versions: versions
      .map((v) => ({
        version: Number(v.version ?? 1),
        content: typeof v.content === "string" ? v.content : undefined,
        storagePath: typeof v.storagePath === "string" ? v.storagePath : undefined,
        url: typeof v.url === "string" ? v.url : undefined,
        note: typeof v.note === "string" ? v.note : undefined,
        createdAt: typeof v.createdAt === "string" ? v.createdAt : new Date().toISOString(),
      }))
      .sort((a, b) => b.version - a.version),
    createdAt: data.createdAt instanceof Date ? data.createdAt.toISOString() : new Date().toISOString(),
    updatedAt: data.updatedAt instanceof Date ? data.updatedAt.toISOString() : new Date().toISOString(),
  };
}

export interface CreateArtifactInput {
  userId: string;
  type: ArtifactType;
  title: string;
  conversationId?: string;
  projectId?: string;
  runId?: string;
  language?: string;
  filename?: string;
  content?: string;
  storagePath?: string;
  url?: string;
  note?: string;
}

export async function createArtifact(input: CreateArtifactInput): Promise<ConversationArtifact> {
  if (!input.content && !input.storagePath && !input.url) {
    throw new Error("Un artefact requiert un contenu, un fichier stocké ou une URL.");
  }
  const now = new Date();
  const ref = adminDb.collection(COLLECTION).doc(randomUUID());
  const version: ArtifactVersion = {
    version: 1,
    content: input.content,
    storagePath: input.storagePath,
    url: input.url,
    note: input.note,
    createdAt: now.toISOString(),
  };
  const data = {
    userId: input.userId,
    conversationId: input.conversationId,
    projectId: input.projectId,
    runId: input.runId,
    type: input.type,
    title: input.title.slice(0, 200),
    language: input.language,
    filename: input.filename,
    content: input.content,
    storagePath: input.storagePath,
    url: input.url,
    versions: [version],
    createdAt: now,
    updatedAt: now,
  };
  // Firestore rejette les champs undefined : on ne garde que les définis.
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await ref.set(clean);
  return { ...input, id: ref.id, versions: [version], createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

/** Ajoute une nouvelle version (contenu ou fichier) à un artefact existant. */
export async function addArtifactVersion(
  userId: string,
  artifactId: string,
  next: { content?: string; storagePath?: string; url?: string; note?: string },
): Promise<ConversationArtifact> {
  const ref = adminDb.collection(COLLECTION).doc(artifactId);
  const updated = await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.userId !== userId) throw new Error("Artefact introuvable.");
    const artifact = docFrom(snap.id, snap.data()!);
    const latest = artifact.versions[0]?.version ?? 0;
    const version: ArtifactVersion = {
      version: latest + 1,
      content: next.content ?? artifact.content,
      storagePath: next.storagePath ?? artifact.storagePath,
      url: next.url ?? artifact.url,
      note: next.note,
      createdAt: new Date().toISOString(),
    };
    tx.update(ref, {
      content: version.content,
      storagePath: version.storagePath,
      url: version.url,
      versions: [version, ...artifact.versions].slice(0, 50),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ...artifact, ...version, versions: [version, ...artifact.versions] };
  });
  return updated;
}

export async function getArtifact(userId: string, artifactId: string): Promise<ConversationArtifact | null> {
  const snap = await adminDb.collection(COLLECTION).doc(artifactId).get();
  if (!snap.exists || snap.data()?.userId !== userId) return null;
  return docFrom(snap.id, snap.data()!);
}

export async function listArtifacts(
  userId: string,
  filters: { conversationId?: string; projectId?: string; type?: ArtifactType; runId?: string; limit?: number } = {},
): Promise<ConversationArtifact[]> {
  const limit = Math.min(filters.limit ?? 50, 200);
  let query: FirebaseFirestore.Query = adminDb.collection(COLLECTION).where("userId", "==", userId);
  if (filters.conversationId) query = query.where("conversationId", "==", filters.conversationId);
  if (filters.projectId) query = query.where("projectId", "==", filters.projectId);
  if (filters.runId) query = query.where("runId", "==", filters.runId);
  if (filters.type) query = query.where("type", "==", filters.type);
  // Pas de orderBy composé (évite un index Firestore dédié) : tri en mémoire.
  const snap = await query.limit(limit).get();
  return snap.docs
    .map((d) => docFrom(d.id, d.data()))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function deleteArtifact(userId: string, artifactId: string): Promise<void> {
  const ref = adminDb.collection(COLLECTION).doc(artifactId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.userId !== userId) throw new Error("Artefact introuvable.");
  await ref.delete();
}
