import "server-only";

import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";

/**
 * Projet — l'équivalent de l'espace de travail Claude : regroupe des
 * conversations, des instructions persistantes, des fichiers et sources,
 * des connecteurs autorisés, des règles de confidentialité et les
 * artefacts générés. Évite de mélanger sujets personnels, métier et
 * techniques.
 */

const COLLECTION = "workspaceProjects";

export interface WorkspaceProject {
  id: string;
  userId: string;
  name: string;
  description?: string;
  /** Instructions persistantes injectées dans chaque conversation du projet. */
  instructions?: string;
  /** Slugs des connecteurs autorisés dans le cadre du projet. */
  authorizedConnectors: string[];
  /** Règles de confidentialité (texte libre, injecté au modèle). */
  privacyRules?: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

function docFrom(id: string, data: FirebaseFirestore.DocumentData): WorkspaceProject {
  return {
    id,
    userId: String(data.userId ?? ""),
    name: String(data.name ?? "Projet"),
    description: typeof data.description === "string" ? data.description : undefined,
    instructions: typeof data.instructions === "string" ? data.instructions : undefined,
    authorizedConnectors: Array.isArray(data.authorizedConnectors)
      ? data.authorizedConnectors.filter((x): x is string => typeof x === "string").slice(0, 64)
      : [],
    privacyRules: typeof data.privacyRules === "string" ? data.privacyRules : undefined,
    status: data.status === "archived" ? "archived" : "active",
    createdAt: data.createdAt instanceof Date ? data.createdAt.toISOString() : new Date().toISOString(),
    updatedAt: data.updatedAt instanceof Date ? data.updatedAt.toISOString() : new Date().toISOString(),
  };
}

export async function createProject(
  userId: string,
  input: { name: string; description?: string; instructions?: string; authorizedConnectors?: string[]; privacyRules?: string },
): Promise<WorkspaceProject> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new Error("Le nom du projet est requis.");
  const now = new Date();
  const ref = adminDb.collection(COLLECTION).doc(randomUUID());
  await ref.set({
    userId,
    name,
    description: input.description?.trim().slice(0, 600) || "",
    instructions: input.instructions?.trim().slice(0, 8000) || "",
    authorizedConnectors: (input.authorizedConnectors ?? []).slice(0, 64),
    privacyRules: input.privacyRules?.trim().slice(0, 2000) || "",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  return {
    id: ref.id,
    userId,
    name,
    description: input.description,
    instructions: input.instructions,
    authorizedConnectors: input.authorizedConnectors ?? [],
    privacyRules: input.privacyRules,
    status: "active",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function listProjects(userId: string, limit = 50): Promise<WorkspaceProject[]> {
  const snap = await adminDb
    .collection(COLLECTION)
    .where("userId", "==", userId)
    .orderBy("updatedAt", "desc")
    .limit(Math.min(limit, 100))
    .get();
  return snap.docs.map((d) => docFrom(d.id, d.data()));
}

export async function getProject(userId: string, id: string): Promise<WorkspaceProject | null> {
  const snap = await adminDb.collection(COLLECTION).doc(id).get();
  if (!snap.exists || snap.data()?.userId !== userId) return null;
  return docFrom(snap.id, snap.data()!);
}

export async function updateProject(
  userId: string,
  id: string,
  patch: Partial<Pick<WorkspaceProject, "name" | "description" | "instructions" | "authorizedConnectors" | "privacyRules" | "status">>,
): Promise<WorkspaceProject> {
  const project = await getProject(userId, id);
  if (!project) throw new Error("Projet introuvable.");
  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 120);
    if (!name) throw new Error("Le nom du projet est requis.");
    update.name = name;
  }
  if (patch.description !== undefined) update.description = patch.description.trim().slice(0, 600);
  if (patch.instructions !== undefined) update.instructions = patch.instructions.trim().slice(0, 8000);
  if (patch.authorizedConnectors !== undefined) update.authorizedConnectors = patch.authorizedConnectors.slice(0, 64);
  if (patch.privacyRules !== undefined) update.privacyRules = patch.privacyRules.trim().slice(0, 2000);
  if (patch.status !== undefined) update.status = patch.status;
  await adminDb.collection(COLLECTION).doc(id).update(update);
  const updated = await getProject(userId, id);
  if (!updated) throw new Error("Projet introuvable après mise à jour.");
  return updated;
}

export async function deleteProject(userId: string, id: string): Promise<void> {
  const project = await getProject(userId, id);
  if (!project) throw new Error("Projet introuvable.");
  // Les conversations rattachées sont détachées (pas supprimées) : aucun
  // contenu utilisateur n'est détruit par la suppression d'un projet.
  const conversations = await adminDb
    .collection("chatConversations")
    .where("userId", "==", userId)
    .where("projectId", "==", id)
    .limit(500)
    .get();
  const batch = adminDb.batch();
  conversations.docs.forEach((d) => batch.update(d.ref, { projectId: FieldValue.delete() }));
  batch.delete(adminDb.collection(COLLECTION).doc(id));
  await batch.commit();
}
