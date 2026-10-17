import "server-only";

import { listJson, userDir } from "@/lib/storage/user-data-store";

import type { TrainingProject } from "./types";

/* ------------------------------------------------------------------ */
/* Quotas du Training Studio (spec §10 — phase gratuite maîtrisée)     */
/*                                                                    */
/* TOUTES les limites sont appliquées CÔTÉ SERVEUR (spec §17 règle 14) */
/* et configurables par variables d'environnement. Aucune n'est        */
/* facturée : la consommation payante est une évolution future qui     */
/* exigera une confirmation explicite (règle 7/8).                     */
/* ------------------------------------------------------------------ */

function intEnv(name: string, fallback: number, min: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  if (Number.isFinite(raw) && raw >= min) return raw;
  return fallback;
}

export interface TrainingQuotas {
  /** Nombre maximal de projets d'entraînement actifs par utilisateur. */
  maxProjects: number;
  /** Jobs d'entraînement simultanés actifs (queued + running) par utilisateur. */
  maxConcurrentJobs: number;
  /** Taille maximale d'un fichier téléversé (modèle ou dataset), en octets. */
  maxUploadBytes: number;
  /** Nombre maximal de datasets par projet. */
  maxDatasetsPerProject: number;
  /** Nombre maximal de modèles importés par projet. */
  maxModelsPerProject: number;
}

export function trainingQuotas(): TrainingQuotas {
  return {
    maxProjects: intEnv("TRAINING_MAX_PROJECTS", 10, 1),
    maxConcurrentJobs: intEnv("TRAINING_MAX_CONCURRENT_JOBS", 1, 1),
    maxUploadBytes: intEnv("TRAINING_MAX_UPLOAD_MB", 200, 1) * 1024 * 1024,
    maxDatasetsPerProject: intEnv("TRAINING_MAX_DATASETS", 50, 1),
    maxModelsPerProject: intEnv("TRAINING_MAX_MODELS", 20, 1),
  };
}

/** Stockage total du Training Studio consommé par l'utilisateur (octets). */
export async function trainingStorageBytes(uid: string): Promise<number> {
  const { listKeys } = await import("@/lib/storage/user-data-store");
  const entries = await listKeys(userDir(uid, "training-files"));
  return entries.reduce((total, entry) => total + (entry.size || 0), 0);
}

/** Vérifie les quotas au moment de la création d'un projet. */
export async function assertCanCreateProject(uid: string): Promise<void> {
  const quotas = trainingQuotas();
  const projects = await listJson<TrainingProject>(userDir(uid, "training", "projects"), {
    limit: quotas.maxProjects + 1,
  });
  const active = projects.filter((p) => p.status === "active");
  if (active.length >= quotas.maxProjects) {
    throw new Error(
      `Quota atteint : ${quotas.maxProjects} projets d'entraînement actifs maximum. Archivez un projet pour en créer un nouveau.`,
    );
  }
}

/** Vérifie le quota de fichiers pour un nouvel asset (upload ou catalogue). */
export async function assertAssetQuota(
  kind: "models" | "datasets",
  uid: string,
  projectId: string,
): Promise<void> {
  const quotas = trainingQuotas();
  const cap = kind === "models" ? quotas.maxModelsPerProject : quotas.maxDatasetsPerProject;
  const existing = await listJson(
    userDir(uid, "training", "projects", projectId, kind),
    { limit: cap + 1 },
  );
  if (existing.length >= cap) {
    throw new Error(
      `Quota atteint : ${cap} ${kind === "models" ? "modèles" : "datasets"} maximum par projet.`,
    );
  }
}

/** Vérifie qu'un nouvel upload respecte la taille maximale autorisée. */
export function assertUploadSize(sizeBytes: number, label = "fichier"): void {
  const max = trainingQuotas().maxUploadBytes;
  if (sizeBytes > max) {
    throw new Error(
      `${label} trop volumineux (${Math.round(sizeBytes / (1024 * 1024))} Mo) : la limite actuelle est ${Math.round(max / (1024 * 1024))} Mo.`,
    );
  }
}

/** Vérifie le quota de concurrence avant d'accepter un plan (création de job). */
export async function assertJobConcurrency(
  uid: string,
  activeJobs: number,
): Promise<void> {
  const max = trainingQuotas().maxConcurrentJobs;
  if (activeJobs >= max) {
    throw new Error(
      `Quota atteint : ${max} tâche(s) d'entraînement simultanée(s) maximum. Attendez la fin des tâches en cours ou annulez-en une.`,
    );
  }
}
