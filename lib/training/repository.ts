import "server-only";

import {
  listJson,
  newUlid,
  readJsonIfExists,
  removeKey,
  removePrefix,
  userDir,
  userKey,
  writeJson,
} from "@/lib/storage/user-data-store";

import {
  datasetAssetSchema,
  exportArtifactSchema,
  modelAssetSchema,
  trainingJobSchema,
  trainingPlanSchema,
  trainingProjectSchema,
  type DatasetAsset,
  type ExportArtifact,
  type ModelAsset,
  type ProjectOverview,
  type TrainingJob,
  type TrainingPlan,
  type TrainingProject,
} from "./types";

/* ------------------------------------------------------------------ */
/* Dépôt Training Studio — R2 via user-data-store                       */
/*                                                                    */
/* Schéma de clés (contrat d'isolation multi-tenant) :                 */
/*   users/{uid}/training/projects/{projectId}.json                    */
/*   users/{uid}/training/projects/{projectId}/models/{assetId}.json   */
/*   users/{uid}/training/projects/{projectId}/datasets/{id}.json      */
/*   users/{uid}/training/projects/{projectId}/plans/{planId}.json     */
/*   users/{uid}/training/projects/{projectId}/jobs/{jobId}.json       */
/*   users/{uid}/training/projects/{projectId}/exports/{id}.json      */
/*   users/{uid}/training-files/{projectId}/{assetId}          (binaire) */
/*                                                                    */
/* Chaque lecture est préfixée par l'uid de l'appelant : un projet     */
/* appartenant à un autre utilisateur est INDISCERNABLE d'un projet    */
/* inexistant (anti-énumération, spec §11).                           */
/* ------------------------------------------------------------------ */

const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

function assertId(value: string, label: string): string {
  const clean = value.trim();
  if (!SEGMENT.test(clean) || clean.includes("..")) {
    throw new Error(`Identifiant ${label} invalide.`);
  }
  return clean;
}

function nowIso(): string {
  return new Date().toISOString();
}

/* ------------------------------ Projets --------------------------- */

export async function listProjects(uid: string): Promise<TrainingProject[]> {
  const projects = await listJson<TrainingProject>(
    userDir(uid, "training", "projects"),
    { limit: 200 },
  );
  return projects
    .map((p) => trainingProjectSchema.safeParse(p))
    .filter((r) => r.success)
    .map((r) => r.data)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getProject(uid: string, projectId: string): Promise<TrainingProject | null> {
  const id = assertId(projectId, "projet");
  const doc = await readJsonIfExists<TrainingProject>(
    userKey(uid, "training", "projects", id),
  );
  if (!doc) return null;
  const parsed = trainingProjectSchema.safeParse(doc);
  return parsed.success ? parsed.data : null;
}

export async function createProject(
  uid: string,
  input: Omit<TrainingProject, "id" | "ownerId" | "createdAt" | "updatedAt" | "v" | "status"> &
    Partial<Pick<TrainingProject, "status">>,
): Promise<TrainingProject> {
  const stamp = nowIso();
  const project = trainingProjectSchema.parse({
    ...input,
    id: newUlid(),
    ownerId: uid,
    status: input.status ?? "active",
    createdAt: stamp,
    updatedAt: stamp,
  });
  await writeJson(userKey(uid, "training", "projects", project.id), project);
  return project;
}

export async function updateProject(
  uid: string,
  projectId: string,
  patch: Partial<Pick<TrainingProject, "name" | "description" | "objective" | "mode" | "status" | "primaryLanguage" | "dataTypes">>,
): Promise<TrainingProject | null> {
  const existing = await getProject(uid, projectId);
  if (!existing) return null;
  const updated = trainingProjectSchema.parse({
    ...existing,
    ...patch,
    id: existing.id,
    ownerId: existing.ownerId,
    updatedAt: nowIso(),
  });
  await writeJson(userKey(uid, "training", "projects", existing.id), updated);
  return updated;
}

/** Supprime un projet ET tout son contenu (assets, plans, jobs, exports, binaires). */
export async function deleteProject(uid: string, projectId: string): Promise<boolean> {
  const id = assertId(projectId, "projet");
  const existing = await getProject(uid, id);
  if (!existing) return false;
  await removePrefix(userDir(uid, "training", "projects", id), { maxObjects: 1000 });
  await removePrefix(userDir(uid, "training-files", id), { maxObjects: 1000 });
  await removePrefix(userDir(uid, "training-exports", id), { maxObjects: 1000 });
  await removeKey(userKey(uid, "training", "projects", id));
  return true;
}

/* ------------------------------ Assets ---------------------------- */

export async function listModels(uid: string, projectId: string): Promise<ModelAsset[]> {
  const id = assertId(projectId, "projet");
  const docs = await listJson<ModelAsset>(
    userDir(uid, "training", "projects", id, "models"),
    { limit: 100 },
  );
  return docs
    .map((d) => modelAssetSchema.safeParse(d))
    .filter((r) => r.success)
    .map((r) => r.data)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getModel(uid: string, projectId: string, assetId: string): Promise<ModelAsset | null> {
  const pid = assertId(projectId, "projet");
  const aid = assertId(assetId, "asset");
  const doc = await readJsonIfExists<ModelAsset>(
    userKey(uid, "training", "projects", pid, "models", aid),
  );
  if (!doc) return null;
  const parsed = modelAssetSchema.safeParse(doc);
  return parsed.success ? parsed.data : null;
}

export async function saveModel(uid: string, asset: ModelAsset): Promise<void> {
  await writeJson(
    userKey(uid, "training", "projects", asset.projectId, "models", asset.id),
    modelAssetSchema.parse(asset),
  );
}

export async function deleteModel(uid: string, projectId: string, assetId: string): Promise<boolean> {
  const pid = assertId(projectId, "projet");
  const aid = assertId(assetId, "asset");
  const existing = await getModel(uid, pid, aid);
  if (!existing) return false;
  await removeKey(userKey(uid, "training", "projects", pid, "models", aid));
  if (existing.storageKey) {
    const { deleteObject } = await import("@/lib/storage/r2");
    await deleteObject(existing.storageKey).catch(() => undefined);
  }
  return true;
}

export async function listDatasets(uid: string, projectId: string): Promise<DatasetAsset[]> {
  const id = assertId(projectId, "projet");
  const docs = await listJson<DatasetAsset>(
    userDir(uid, "training", "projects", id, "datasets"),
    { limit: 200 },
  );
  return docs
    .map((d) => datasetAssetSchema.safeParse(d))
    .filter((r) => r.success)
    .map((r) => r.data)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getDataset(uid: string, projectId: string, datasetId: string): Promise<DatasetAsset | null> {
  const pid = assertId(projectId, "projet");
  const did = assertId(datasetId, "dataset");
  const doc = await readJsonIfExists<DatasetAsset>(
    userKey(uid, "training", "projects", pid, "datasets", did),
  );
  if (!doc) return null;
  const parsed = datasetAssetSchema.safeParse(doc);
  return parsed.success ? parsed.data : null;
}

export async function saveDataset(uid: string, asset: DatasetAsset): Promise<void> {
  await writeJson(
    userKey(uid, "training", "projects", asset.projectId, "datasets", asset.id),
    datasetAssetSchema.parse(asset),
  );
}

export async function deleteDataset(uid: string, projectId: string, datasetId: string): Promise<boolean> {
  const pid = assertId(projectId, "projet");
  const did = assertId(datasetId, "dataset");
  const existing = await getDataset(uid, pid, did);
  if (!existing) return false;
  await removeKey(userKey(uid, "training", "projects", pid, "datasets", did));
  const { deleteObject } = await import("@/lib/storage/r2");
  await deleteObject(existing.storageKey).catch(() => undefined);
  return true;
}

/* ------------------------------ Plans ----------------------------- */

export async function listPlans(uid: string, projectId: string): Promise<TrainingPlan[]> {
  const id = assertId(projectId, "projet");
  const docs = await listJson<TrainingPlan>(
    userDir(uid, "training", "projects", id, "plans"),
    { limit: 100 },
  );
  return docs
    .map((d) => trainingPlanSchema.safeParse(d))
    .filter((r) => r.success)
    .map((r) => r.data)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getPlan(uid: string, projectId: string, planId: string): Promise<TrainingPlan | null> {
  const pid = assertId(projectId, "projet");
  const plid = assertId(planId, "plan");
  const doc = await readJsonIfExists<TrainingPlan>(
    userKey(uid, "training", "projects", pid, "plans", plid),
  );
  if (!doc) return null;
  const parsed = trainingPlanSchema.safeParse(doc);
  return parsed.success ? parsed.data : null;
}

export async function savePlan(uid: string, plan: TrainingPlan): Promise<void> {
  await writeJson(
    userKey(uid, "training", "projects", plan.projectId, "plans", plan.id),
    trainingPlanSchema.parse(plan),
  );
}

/* ------------------------------ Jobs ------------------------------ */

export async function listJobs(uid: string, projectId: string): Promise<TrainingJob[]> {
  const id = assertId(projectId, "projet");
  const docs = await listJson<TrainingJob>(
    userDir(uid, "training", "projects", id, "jobs"),
    { limit: 100 },
  );
  return docs
    .map((d) => trainingJobSchema.safeParse(d))
    .filter((r) => r.success)
    .map((r) => r.data)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getJob(uid: string, projectId: string, jobId: string): Promise<TrainingJob | null> {
  const pid = assertId(projectId, "projet");
  const jid = assertId(jobId, "job");
  const doc = await readJsonIfExists<TrainingJob>(
    userKey(uid, "training", "projects", pid, "jobs", jid),
  );
  if (!doc) return null;
  const parsed = trainingJobSchema.safeParse(doc);
  return parsed.success ? parsed.data : null;
}

export async function saveJob(uid: string, job: TrainingJob): Promise<void> {
  await writeJson(
    userKey(uid, "training", "projects", job.projectId, "jobs", job.id),
    trainingJobSchema.parse(job),
  );
}

/** Jobs actifs d'un utilisateur, TOUS projets confondus (quota de concurrence). */
export async function listActiveJobsForUser(uid: string): Promise<TrainingJob[]> {
  const projects = await listProjects(uid);
  const active: TrainingJob[] = [];
  for (const project of projects) {
    const jobs = await listJobs(uid, project.id);
    active.push(
      ...jobs.filter((j) => j.status === "queued" || j.status === "scheduled" || j.status === "running"),
    );
  }
  return active;
}

/* ------------------------------ Exports --------------------------- */

export async function listExports(uid: string, projectId: string): Promise<ExportArtifact[]> {
  const id = assertId(projectId, "projet");
  const docs = await listJson<ExportArtifact>(
    userDir(uid, "training", "projects", id, "exports"),
    { limit: 100 },
  );
  return docs
    .map((d) => exportArtifactSchema.safeParse(d))
    .filter((r) => r.success)
    .map((r) => r.data)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getExport(uid: string, projectId: string, exportId: string): Promise<ExportArtifact | null> {
  const pid = assertId(projectId, "projet");
  const eid = assertId(exportId, "export");
  const doc = await readJsonIfExists<ExportArtifact>(
    userKey(uid, "training", "projects", pid, "exports", eid),
  );
  if (!doc) return null;
  const parsed = exportArtifactSchema.safeParse(doc);
  return parsed.success ? parsed.data : null;
}

export async function saveExport(uid: string, artifact: ExportArtifact): Promise<void> {
  await writeJson(
    userKey(uid, "training", "projects", artifact.projectId, "exports", artifact.id),
    exportArtifactSchema.parse(artifact),
  );
}

/* --------------------------- Vue agrégée -------------------------- */

export async function getProjectOverview(uid: string, projectId: string): Promise<ProjectOverview | null> {
  const project = await getProject(uid, projectId);
  if (!project) return null;
  const [models, datasets, plans, jobs, exports] = await Promise.all([
    listModels(uid, project.id),
    listDatasets(uid, project.id),
    listPlans(uid, project.id),
    listJobs(uid, project.id),
    listExports(uid, project.id),
  ]);
  return { project, models, datasets, plans, jobs, exports };
}
