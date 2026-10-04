import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 1 : Video Project Manager (spec §3).
 *
 * Chaque production est un projet persistant : brouillon, sauvegarde
 * automatique, historique, versions, reprise après interruption,
 * duplication, suppression (avec purge stockage), export, rendu en
 * arrière-plan. Les projets vivent dans Firestore (adminDb, cloisonnement
 * userId strict) ; les gros objets vivent dans R2 (lib/video/storage).
 */

import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import {
  resilientCreate,
  resilientGet,
  resilientSet,
  resilientList,
  resilientListByPayloadField,
  resilientCount,
} from "@/lib/db/firestore-fallback";
import {
  type VideoProject,
  type VideoProjectStatus,
  type ProductionLogEntry,
  type ProjectVersion,
  VIDEO_PROJECT_STATUSES,
} from "@/lib/video/types";
import { VIDEO_LIMITS, VideoQuotaError } from "@/lib/video/security";
import { deleteProjectStorage } from "@/lib/video/storage";

export const PROJECTS_COLLECTION = "videoProjects";
export const VERSIONS_COLLECTION = "videoVersions";

function nowIso(): string {
  return new Date().toISOString();
}

function emptyStats(): VideoProject["stats"] {
  return { sceneCount: 0, assetCount: 0, renderedSeconds: 0, qcRounds: 0, billedMinor: 0 };
}

export function emptyVisualBible(): VideoProject["visualBible"] {
  return {
    styleDescriptors: "",
    palette: "",
    characters: [],
    locations: [],
    negativePrompt: "texte illisible, artefacts, déformations, watermark",
  };
}

export interface CreateProjectInput {
  title: string;
  description?: string;
  language?: string;
  aspectRatio?: VideoProject["aspectRatio"];
  resolution?: VideoProject["resolution"];
  fps?: VideoProject["fps"];
  targetDurationSec?: number;
  style?: string;
  audience?: string;
  platform?: string;
  voicePreference?: VideoProject["voicePreference"];
  musicMood?: string;
  orgId?: string;
}

export async function createProject(userId: string, input: CreateProjectInput): Promise<VideoProject> {
  const activeCount = await countActiveProjects(userId);
  if (activeCount >= VIDEO_LIMITS.maxActiveProjects) {
    throw new VideoQuotaError(
      `Limite de ${VIDEO_LIMITS.maxActiveProjects} projets actifs atteinte. Archivez un projet pour en créer un nouveau.`,
    );
  }
  const id = randomUUID();
  const now = nowIso();
  const project: VideoProject = {
    id,
    userId,
    orgId: input.orgId,
    title: input.title,
    description: input.description ?? "",
    language: input.language ?? "fr",
    aspectRatio: input.aspectRatio ?? "16:9",
    resolution: input.resolution ?? "1080p",
    fps: input.fps ?? 30,
    targetDurationSec: input.targetDurationSec ?? 180,
    style: input.style ?? "documentaire cinématographique",
    audience: input.audience,
    platform: input.platform,
    voicePreference: input.voicePreference ?? { kind: "auto" },
    musicMood: input.musicMood,
    status: "draft",
    visualBible: emptyVisualBible(),
    productionLog: [
      { at: now, actor: "system", message: `Projet créé — objectif : ${input.targetDurationSec ?? 180}s.` },
    ],
    versionCounter: 1,
    stats: emptyStats(),
    createdAt: now,
    updatedAt: now,
  };
  await resilientCreate(PROJECTS_COLLECTION, id, { ...project }, userId);
  return project;
}

export async function countActiveProjects(userId: string): Promise<number> {
  const projects = await resilientList<VideoProject>(PROJECTS_COLLECTION, "userId", userId);
  return projects.filter((project) => project.status !== "archived").length;
}

/**
 * Lecture avec cloisonnement strict : un projet n'existe que pour son
 * propriétaire (les projets d'organisation viendront via assertResourceRead
 * quand la facette team de la vidéo sera ouverte — même squelette que les
 * autres ressources tenants/).
 */
export async function getOwnedProject(userId: string, projectId: string): Promise<VideoProject | null> {
  const data = await resilientGet<VideoProject>(PROJECTS_COLLECTION, projectId);
  if (!data || data.userId !== userId) return null;
  return data;
}

export async function getOwnedProjectOrThrow(userId: string, projectId: string): Promise<VideoProject> {
  const project = await getOwnedProject(userId, projectId);
  if (!project) throw new Error("Projet vidéo introuvable.");
  return project;
}

export async function listProjects(userId: string): Promise<VideoProject[]> {
  const projects = await resilientList<VideoProject>(PROJECTS_COLLECTION, "userId", userId);
  // Tri en mémoire (pas d'index composite requis — requête single-field).
  projects.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return projects;
}

/** Sauvegarde automatique / patch partiel — met toujours à jour updatedAt. */
export async function patchProject(
  userId: string,
  projectId: string,
  patch: Partial<Omit<VideoProject, "id" | "userId" | "createdAt">>,
): Promise<VideoProject> {
  const project = await getOwnedProjectOrThrow(userId, projectId);
  const merged: VideoProject = {
    ...project,
    ...patch,
    id: project.id,
    userId: project.userId,
    createdAt: project.createdAt,
    updatedAt: nowIso(),
  };
  await resilientSet(PROJECTS_COLLECTION, projectId, merged, { ownerId: userId });
  return merged;
}

export async function setProjectStatus(userId: string, projectId: string, status: VideoProjectStatus): Promise<void> {
  if (!VIDEO_PROJECT_STATUSES.includes(status)) throw new Error(`Statut inconnu : ${status}`);
  await resilientSet(
    PROJECTS_COLLECTION,
    projectId,
    { status, updatedAt: nowIso() },
    { merge: true, ownerId: userId },
  );
}

export async function appendProductionLog(
  userId: string,
  projectId: string,
  entry: Omit<ProductionLogEntry, "at">,
): Promise<void> {
  const project = await getOwnedProjectOrThrow(userId, projectId);
  const log = [...project.productionLog, { at: nowIso(), ...entry }].slice(-200);
  await resilientSet(PROJECTS_COLLECTION, projectId, { productionLog: log, updatedAt: nowIso() }, { merge: true, ownerId: userId });
}

export async function logSystem(projectId: string, message: string): Promise<void> {
  // Variante système (worker) : ne re-vérifie pas la propriété (appel interne).
  const project = await resilientGet<VideoProject>(PROJECTS_COLLECTION, projectId);
  if (!project) return;
  const log = [...(project.productionLog ?? []), { at: nowIso(), actor: "system" as const, message }].slice(-200);
  await resilientSet(PROJECTS_COLLECTION, projectId, { productionLog: log, updatedAt: nowIso() }, { merge: true, ownerId: project.userId });
}

/** Duplication complète : documents recopiés, assets R2 conservés (mêmes clés). */
export async function duplicateProject(userId: string, projectId: string): Promise<VideoProject> {
  const source = await getOwnedProjectOrThrow(userId, projectId);
  const copy = await createProject(userId, {
    title: `${source.title} (copie)`,
    description: source.description,
    language: source.language,
    aspectRatio: source.aspectRatio,
    resolution: source.resolution,
    fps: source.fps,
    targetDurationSec: source.targetDurationSec,
    style: source.style,
    audience: source.audience,
    platform: source.platform,
    voicePreference: source.voicePreference,
    musicMood: source.musicMood,
    orgId: source.orgId,
  });
  await resilientSet(PROJECTS_COLLECTION, copy.id, {
    visualBible: source.visualBible,
    script: source.script ?? null,
    storyboard: source.storyboard ?? null,
    timeline: source.timeline ?? null,
    status: source.script ? source.status : "draft",
    stats: { ...emptyStats(), assetCount: source.stats.assetCount },
    updatedAt: nowIso(),
  }, { merge: true, ownerId: userId });
  return (await getOwnedProject(copy.userId, copy.id))!;
}

/** Suppression : purge Firestore + stockage R2 (irréversible, demandée explicitement). */
export async function deleteProject(userId: string, projectId: string): Promise<{ storageDeleted: number }> {
  const project = await getOwnedProjectOrThrow(userId, projectId);
  const storageDeleted = await deleteProjectStorage(userId, project.id);
  const batch = adminDb.batch();
  batch.delete(adminDb.collection(PROJECTS_COLLECTION).doc(projectId));
  // Sous-ressources liées : assets, jobs, versions.
  for (const collection of ["videoAssets", "videoRenderJobs", "videoVersions"]) {
    const snap = await adminDb.collection(collection).where("projectId", "==", projectId).get();
    snap.docs.forEach((d) => batch.delete(d.ref));
  }
  await batch.commit();
  return { storageDeleted };
}

// ────────────────────────────────────────────────────────────────────────────
// Versions — historique complet, restauration, snapshot avant chaque révision
// ────────────────────────────────────────────────────────────────────────────

export async function snapshotVersion(
  userId: string,
  projectId: string,
  label: string,
  createdBy: ProjectVersion["createdBy"],
  note?: string,
): Promise<ProjectVersion> {
  const project = await getOwnedProjectOrThrow(userId, projectId);
  const version: ProjectVersion = {
    id: randomUUID(),
    projectId,
    versionNumber: project.versionCounter,
    label,
    createdBy,
    snapshot: {
      script: project.script,
      storyboard: project.storyboard,
      timeline: project.timeline,
      visualBible: project.visualBible,
    },
    note,
    createdAt: nowIso(),
  };
  await resilientCreate(VERSIONS_COLLECTION, version.id, { ...version }, userId);
  await resilientSet(
    PROJECTS_COLLECTION,
    projectId,
    { versionCounter: project.versionCounter + 1, updatedAt: nowIso() },
    { merge: true, ownerId: userId },
  );
  return version;
}

export async function listVersions(userId: string, projectId: string): Promise<ProjectVersion[]> {
  await getOwnedProjectOrThrow(userId, projectId);
  const versions = await resilientListByPayloadField<ProjectVersion>(VERSIONS_COLLECTION, "projectId", projectId);
  versions.sort((a, b) => b.versionNumber - a.versionNumber);
  return versions;
}

/**
 * « Reviens à la version 2 » — restaure l'instantané complet et crée une
 * nouvelle version qui trace la restauration (l'historique n'est jamais
 * réécrit).
 */
export async function restoreVersion(userId: string, projectId: string, versionNumber: number): Promise<VideoProject> {
  const versions = await listVersions(userId, projectId);
  const target = versions.find((v) => v.versionNumber === versionNumber);
  if (!target) throw new Error(`Version ${versionNumber} introuvable.`);
  const restored = await patchProject(userId, projectId, {
    script: target.snapshot.script ?? undefined,
    storyboard: target.snapshot.storyboard ?? undefined,
    timeline: target.snapshot.timeline ?? undefined,
    visualBible: target.snapshot.visualBible,
  });
  await snapshotVersion(userId, projectId, `Restauration de la version ${versionNumber}`, "user", target.label);
  await appendProductionLog(userId, projectId, {
    actor: "user",
    message: `Restauration : version ${versionNumber} (${target.label}).`,
  });
  return restored;
}
