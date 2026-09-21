import { randomUUID } from "node:crypto";
import { FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore";
import { z } from "zod";

import { adminDb } from "@/lib/firebase/admin";

import { VideoProjectSchema, type VideoProject } from "./types";

/**
 * Persistance des projets vidéo du Studio (collection Firestore
 * `videoProjects`, scopusée par propriétaire).
 */

const COLLECTION = "videoProjects";
export const MAX_PROJECTS_PER_USER = 40;

export const VideoProjectCreateSchema = VideoProjectSchema.extend({
  sceneCount: z.number().int().min(3).max(20).optional(),
}).omit({ scenes: true, status: true });

export const VideoProjectPatchSchema = z.object({
  // Édition directe du storyboard (cartes) ou instruction conversationnelle.
  scenes: VideoProjectSchema.shape.scenes.optional(),
  title: VideoProjectSchema.shape.title.optional(),
  instruction: z.string().trim().min(2).max(2_000).optional(),
  status: VideoProjectSchema.shape.status.optional(),
});

export interface StoredVideoProject extends VideoProject {
  id: string;
  userId: string;
  createdAt?: string;
  updatedAt?: string;
}

export async function countProjects(userId: string): Promise<number> {
  const snap = await adminDb.collection(COLLECTION).where("userId", "==", userId).count().get();
  return snap.data().count;
}

export async function createProject(userId: string, data: VideoProject): Promise<StoredVideoProject> {
  const id = randomUUID();
  const now = FieldValue.serverTimestamp();
  await adminDb.collection(COLLECTION).doc(id).set({
    ...data,
    userId,
    createdAt: now,
    updatedAt: now,
  });
  const created = await getProject(userId, id);
  if (!created) throw new Error("Le projet vidéo n'a pas pu être créé.");
  return created;
}

export async function listProjects(userId: string, limit = 30): Promise<StoredVideoProject[]> {
  const snap = await adminDb.collection(COLLECTION).where("userId", "==", userId).limit(limit).get();
  return snap.docs
    .map((doc) => serialize(doc.id, doc.data()))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export async function getProject(userId: string, id: string): Promise<StoredVideoProject | null> {
  const snap = await adminDb.collection(COLLECTION).doc(id).get();
  if (!snap.exists || snap.data()?.userId !== userId) return null;
  return serialize(id, snap.data()!);
}

export async function updateProject(userId: string, id: string, patch: Partial<VideoProject>): Promise<StoredVideoProject> {
  const ref = adminDb.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.userId !== userId) throw new Error("Projet vidéo introuvable.");
  await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
  const updated = await getProject(userId, id);
  if (!updated) throw new Error("Projet vidéo introuvable.");
  return updated;
}

export async function deleteProject(userId: string, id: string): Promise<void> {
  const ref = adminDb.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.userId !== userId) throw new Error("Projet vidéo introuvable.");
  await ref.delete();
}

function serialize(id: string, data: DocumentData): StoredVideoProject {
  const parsed = VideoProjectSchema.parse({
    title: data.title ?? "Projet vidéo",
    brief: data.brief ?? "",
    format: data.format ?? "16:9",
    scenes: Array.isArray(data.scenes) ? data.scenes : [],
    status: data.status ?? "planned",
  });
  const toIso = (value: unknown) => value instanceof Timestamp ? value.toDate().toISOString() : undefined;
  return {
    ...parsed,
    id,
    userId: String(data.userId),
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
  };
}
