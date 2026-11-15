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
  /** Stockage TOTAL du Training Studio par utilisateur (octets) — v1.1. */
  maxStorageBytes: number;
  /** Minutes d'entraînement (exécution réelle) par mois civil — v1.1. */
  maxTrainingMinutesPerMonth: number;
  /** Taille totale maximale d'un import hub (Hugging Face / Kaggle) — v1.1. */
  maxHubImportBytes: number;
}

export function trainingQuotas(): TrainingQuotas {
  return {
    maxProjects: intEnv("TRAINING_MAX_PROJECTS", 10, 1),
    maxConcurrentJobs: intEnv("TRAINING_MAX_CONCURRENT_JOBS", 1, 1),
    maxUploadBytes: intEnv("TRAINING_MAX_UPLOAD_MB", 200, 1) * 1024 * 1024,
    maxDatasetsPerProject: intEnv("TRAINING_MAX_DATASETS", 50, 1),
    maxModelsPerProject: intEnv("TRAINING_MAX_MODELS", 20, 1),
    maxStorageBytes: intEnv("TRAINING_MAX_STORAGE_MB", 2048, 1) * 1024 * 1024,
    maxTrainingMinutesPerMonth: intEnv("TRAINING_MAX_MINUTES_PER_MONTH", 60, 1),
    maxHubImportBytes: intEnv("TRAINING_MAX_HUB_IMPORT_MB", 500, 1) * 1024 * 1024,
  };
}

/** Stockage total du Training Studio consommé par l'utilisateur (octets). */
export async function trainingStorageBytes(uid: string): Promise<number> {
  const { listKeys } = await import("@/lib/storage/user-data-store");
  const [files, exports_] = await Promise.all([
    listKeys(userDir(uid, "training-files")),
    listKeys(userDir(uid, "training-exports")),
  ]);
  return (
    files.reduce((total, entry) => total + (entry.size || 0), 0) +
    exports_.reduce((total, entry) => total + (entry.size || 0), 0)
  );
}

/**
 * Vérifie le quota de STOCKAGE TOTAL avant d'écrire `incomingBytes` de plus
 * (v1.1 — spec §10 : consommation calculée côté serveur, jamais au client).
 */
export async function assertStorageQuota(uid: string, incomingBytes: number): Promise<void> {
  const max = trainingQuotas().maxStorageBytes;
  const current = await trainingStorageBytes(uid);
  if (current + incomingBytes > max) {
    throw new Error(
      `Quota de stockage dépassé : ${Math.round(current / 1048576)} Mo utilisés + ` +
        `${Math.round(incomingBytes / 1048576)} Mo entrants > plafond ${Math.round(max / 1048576)} Mo. ` +
        "Supprimez des datasets, modèles ou exports obsolètes pour libérer de l'espace.",
    );
  }
}

/**
 * Minutes d'entraînement RÉELLEMENT consommées ce mois civil (UTC) :
 * somme des durées des jobs DÉMARRÉS (running compte jusqu'à maintenant,
 * terminés jusqu'à finishedAt ; jamais démarrés = 0 minute).
 */
export async function trainingMinutesUsedThisMonth(uid: string): Promise<number> {
  const { listJobs } = await import("@/lib/training/repository");
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const projects = await listJson<TrainingProject>(userDir(uid, "training", "projects"), { limit: 200 });
  let milliseconds = 0;
  for (const project of projects) {
    const jobs = await listJobs(uid, project.id);
    for (const job of jobs) {
      if (!job.startedAt || job.startedAt < monthStart) continue;
      const end =
        job.finishedAt !== null && job.finishedAt !== undefined
          ? Date.parse(job.finishedAt)
          : job.status === "running"
            ? Date.now()
            : null;
      if (end === null || !Number.isFinite(end)) continue;
      milliseconds += Math.max(0, end - Date.parse(job.startedAt));
    }
  }
  return milliseconds / 60_000;
}

/**
 * Vérifie le budget de minutes du mois avant d'accepter un plan dont la
 * durée ESTIMÉE est connue (estimation = plafond prudent, pas une mesure).
 * Sans estimation (null/0), rien n'est bloqué : le suivi reste exact côté
 * consommation réelle (règle « estimation ≠ mesure », spec §2).
 */
export async function assertTrainingMinutesBudget(uid: string, estimatedMinutes: number): Promise<void> {
  if (!Number.isFinite(estimatedMinutes) || estimatedMinutes <= 0) return;
  const max = trainingQuotas().maxTrainingMinutesPerMonth;
  const used = await trainingMinutesUsedThisMonth(uid);
  if (used + estimatedMinutes > max) {
    throw new Error(
      `Quota d'entraînement mensuel dépassé : ${Math.round(used)} min réellement utilisées + ` +
        `${Math.round(estimatedMinutes)} min estimées > plafond ${max} min. ` +
        "Attendez le mois prochain ou réduisez la durée estimée (époques, taille des données).",
    );
  }
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
