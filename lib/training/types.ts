import "server-only";

import { z } from "zod";

/* ------------------------------------------------------------------ */
/* AI Training Studio — types du domaine                                */
/*                                                                    */
/* Contrat d'honnêteté (spec §2/§17) :                                 */
/*  - un job N'EST JAMAIS marqué "completed" sans exécution réelle     */
/*    d'un fournisseur (mock explicitement étiqueté `simulated`,       */
/*    réservé aux environnements de test/dev) ;                        */
/*  - la progression provient du fournisseur ou reste null ;           */
/*  - une estimation est TOUJOURS distinguée d'une mesure (champs      */
/*    `*Estimate` vs champs constatés).                                */
/* ------------------------------------------------------------------ */

/** Familles de modèles supportées par le catalogue extensible. */
export const TRAINING_FAMILIES = ["text", "image", "audio", "video", "multimodal", "specialized"] as const;
export type TrainingFamily = (typeof TRAINING_FAMILIES)[number];

/**
 * Méthodes d'entraînement. Le RAG est explicitement distinct d'un
 * entraînement des poids (spec §2) : il n'entraîne rien, il indexe.
 */
export const TRAINING_METHODS = [
  "full-training",
  "finetune",
  "lora",
  "qlora",
  "adapter",
  "eval-only",
  "quantize",
  "convert",
  "rag",
] as const;
export type TrainingMethod = (typeof TRAINING_METHODS)[number];

/** Trois modes de fonctionnement (spec §5) — mêmes services, même sécurité. */
export const TRAINING_MODES = ["auto", "assisted", "advanced"] as const;
export type TrainingMode = (typeof TRAINING_MODES)[number];

/** Statuts d'un projet d'entraînement. */
export const PROJECT_STATUSES = ["active", "archived"] as const;

/** Statuts d'un asset modèle : la quarantaine précède toute décision. */
export const MODEL_ASSET_STATUSES = ["pending", "valid", "quarantined", "rejected"] as const;

/** Formats de fichiers modèle réellement vérifiés par la validation. */
export const MODEL_FILE_FORMATS = ["safetensors", "gguf", "zip-archive", "config-only"] as const;
export type ModelFileFormat = (typeof MODEL_FILE_FORMATS)[number];

/** Splits de datasets — la séparation empêche les fuites (spec §4 étape 3). */
export const DATASET_SPLITS = ["train", "validation", "test", "unassigned"] as const;
export type DatasetSplit = (typeof DATASET_SPLITS)[number];

export const DATASET_FORMATS = ["csv", "json", "jsonl", "txt"] as const;
export type DatasetFormat = (typeof DATASET_FORMATS)[number];

/**
 * Origine d'un dataset (v1.1 — import depuis les hubs) :
 *  - "upload" : fichier téléversé par l'utilisateur ;
 *  - "huggingface" / "kaggle" : fichier réellement téléchargé depuis le hub
 *    du même nom, puis validé par le MÊME pipeline (stats, doublons, PII).
 */
export const DATASET_SOURCES = ["upload", "huggingface", "kaggle"] as const;
export type DatasetSource = (typeof DATASET_SOURCES)[number];

/** Machine à états d'un job — les transitions sont validées par l'orchestrateur. */
export const JOB_STATUSES = ["queued", "scheduled", "running", "completed", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Schémas zod                                                        */
/* ------------------------------------------------------------------ */

export const trainingFamilySchema = z.enum(TRAINING_FAMILIES);
export const trainingMethodSchema = z.enum(TRAINING_METHODS);
export const trainingModeSchema = z.enum(TRAINING_MODES);
export const datasetSplitSchema = z.enum(DATASET_SPLITS);

export const validationFindingSchema = z.object({
  level: z.enum(["info", "warn", "error"]),
  code: z.string().min(1),
  message: z.string().min(1),
});

export const trainingProjectSchema = z.object({
  v: z.literal(1).default(1),
  id: z.string().min(1),
  ownerId: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  family: trainingFamilySchema,
  objective: z.string().max(2000).default(""),
  primaryLanguage: z.string().max(40).default("fr"),
  dataTypes: z.array(z.string().max(40)).max(10).default([]),
  mode: trainingModeSchema.default("assisted"),
  status: z.enum(PROJECT_STATUSES).default("active"),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TrainingProject = z.infer<typeof trainingProjectSchema>;
export type TrainingProjectInput = z.input<typeof trainingProjectSchema>;

export const modelAssetSchema = z.object({
  v: z.literal(1).default(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  ownerId: z.string().min(1),
  name: z.string().min(1).max(180),
  /** "upload" : fichier fourni par l'utilisateur ; "catalog" : modèle de base référencé (aucun téléchargement). */
  source: z.enum(["upload", "catalog"]),
  /** Identifiant catalogue (ex. "meta-llama/Llama-3.2-1B-Instruct") quand source = "catalog". */
  catalogId: z.string().max(200).nullish(),
  format: z.enum(MODEL_FILE_FORMATS).nullish(),
  storageKey: z.string().nullish(),
  sizeBytes: z.number().int().nonnegative().default(0),
  sha256: z.string().nullish(),
  status: z.enum(MODEL_ASSET_STATUSES),
  findings: z.array(validationFindingSchema).default([]),
  /** Métadonnées détectées par la validation (architecture, tenseurs, quantification…). */
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ModelAsset = z.infer<typeof modelAssetSchema>;

export const datasetStatsSchema = z.object({
  rows: z.number().int().nonnegative(),
  columns: z.array(z.string()).default([]),
  /** Paires question/réponse détectées (clés type instruction/response…). */
  pairs: z.number().int().nonnegative().default(0),
  duplicates: z.number().int().nonnegative().default(0),
  emptyLines: z.number().int().nonnegative().default(0),
  warnings: z.array(z.string()).default([]),
});
export type DatasetStats = z.infer<typeof datasetStatsSchema>;

/**
 * Métadonnées d'origine d'un dataset importé depuis un hub (v1.1).
 * UNIQUEMENT des données RÉELLES remontées par l'API du hub au moment de
 * l'inspection — jamais de chiffre inventé. `totalRows`/`splits` reflètent
 * la déclaration du hub (utile quand seul un sous-ensemble de fichiers a
 * pu être téléchargé sous les plafonds).
 */
export const datasetOriginMetadataSchema = z.object({
  provider: z.enum(["huggingface", "kaggle"]).nullish(),
  /** Référence hub d'origine (owner/dataset). */
  hubRef: z.string().max(240).nullish(),
  /** Lignes TOTALES déclarées par le hub (toutes splits confondues), si exposées. */
  totalRows: z.number().int().nonnegative().nullish(),
  /** Splits déclarés par le hub (nom → lignes), si exposés. */
  splits: z
    .array(z.object({ name: z.string().max(60), rows: z.number().int().nonnegative().nullable() }))
    .max(20)
    .default([]),
  license: z.string().max(120).nullish(),
  /** Nombre de fichiers du hub réellement téléchargés / écartés sous plafond. */
  importedFiles: z.number().int().nonnegative().default(0),
  skippedFiles: z.number().int().nonnegative().default(0),
  inspectedAt: z.string().nullish(),
});
export type DatasetOriginMetadata = z.infer<typeof datasetOriginMetadataSchema>;

export const datasetAssetSchema = z.object({
  v: z.literal(1).default(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  ownerId: z.string().min(1),
  name: z.string().min(1).max(180),
  format: z.enum(DATASET_FORMATS),
  /** Origine du fichier (v1.1) : téléversement ou hub Hugging Face / Kaggle. */
  source: z.enum(DATASET_SOURCES).default("upload"),
  /** Référence hub (owner/dataset) quand source = "huggingface" | "kaggle". */
  hubRef: z.string().max(240).nullish(),
  /** Métadonnées réelles du hub au moment de l'import (v1.1). */
  originMetadata: datasetOriginMetadataSchema.optional(),
  /** Échantillon de lignes réelles du hub (≤ 10 lignes, cellules tronquées). */
  previewRows: z.array(z.record(z.string(), z.unknown())).max(10).default([]),
  storageKey: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  split: datasetSplitSchema.default("unassigned"),
  stats: datasetStatsSchema,
  status: z.enum(["valid", "rejected"]),
  findings: z.array(validationFindingSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DatasetAsset = z.infer<typeof datasetAssetSchema>;

export const trainingPlanSchema = z.object({
  v: z.literal(1).default(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  ownerId: z.string().min(1),
  method: trainingMethodSchema,
  engineId: z.string().min(1),
  /** Modèle de base : assetId d'un upload validé OU identifiant catalogue. */
  baseModel: z.string().min(1),
  baseModelKind: z.enum(["upload", "catalog"]),
  /** Hyperparamètres proposés — validés contre les capacités du moteur. */
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  /** ESTIMATIONS clairement étiquetées (jamais des mesures). */
  resources: z.object({
    vramGbEstimate: z.number().positive().nullish(),
    storageGbEstimate: z.number().positive().nullish(),
    estimatedDurationMinutes: z.number().positive().nullish(),
    providerClass: z.string().nullish(),
  }),
  risks: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  expectedOutcomes: z.string().default(""),
  evaluationCriteria: z.array(z.string()).default([]),
  /** "assistant-llm" : généré par l'assistant ; "heuristic-fallback" : règles déterministes (IA indisponible). */
  generatedBy: z.enum(["assistant-llm", "heuristic-fallback"]),
  status: z.enum(["proposed", "accepted", "rejected", "superseded"]),
  createdAt: z.string(),
  acceptedAt: z.string().nullish(),
});
export type TrainingPlan = z.infer<typeof trainingPlanSchema>;

export const trainingEventSchema = z.object({
  at: z.string(),
  level: z.enum(["info", "warn", "error"]),
  message: z.string().min(1).max(1000),
});
export type TrainingEvent = z.infer<typeof trainingEventSchema>;

/** Cap maximal d'événements conservés par job (rotation, doc < 256 Ko). */
export const JOB_EVENT_CAP = 300;

export const trainingJobSchema = z.object({
  v: z.literal(1).default(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  planId: z.string().min(1),
  ownerId: z.string().min(1),
  status: z.enum(JOB_STATUSES),
  /** Progression RÉELLE rapportée par le fournisseur — jamais calculée/simulée. */
  progressPercent: z.number().int().min(0).max(100).nullish(),
  currentStep: z.string().nullish(),
  epochsTotal: z.number().int().positive().nullish(),
  epochsDone: z.number().int().nonnegative().nullish(),
  trainLoss: z.number().nullish(),
  metrics: z.record(z.string(), z.number()).default({}),
  /** Raison d'attente honnête (ex. "no-gpu-provider") quand rien n'est disponible. */
  waitingReason: z.string().nullish(),
  /** Vrai UNIQUEMENT pour le fournisseur mock (tests/dev) — jamais en production. */
  simulated: z.boolean().default(false),
  providerId: z.string().nullish(),
  externalJobId: z.string().nullish(),
  startedAt: z.string().nullish(),
  finishedAt: z.string().nullish(),
  error: z.string().nullish(),
  /** Artefacts produits par le fournisseur (remplis uniquement à la complétion réelle). */
  artifacts: z.array(z.object({
    label: z.string().max(200).default(""),
    storageKey: z.string(),
    sizeBytes: z.number().int().nonnegative().default(0),
  })).default([]),
  events: z.array(trainingEventSchema).max(JOB_EVENT_CAP).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TrainingJob = z.infer<typeof trainingJobSchema>;

export const exportArtifactSchema = z.object({
  v: z.literal(1).default(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  ownerId: z.string().min(1),
  kind: z.enum(["dataset-archive", "model-files", "plan-config", "trained-model"]),
  label: z.string().max(200).default(""),
  storageKey: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type ExportArtifact = z.infer<typeof exportArtifactSchema>;

/** Vue agrégée renvoyée au client (projet + assets + plans + jobs + exports). */
export interface ProjectOverview {
  project: TrainingProject;
  models: ModelAsset[];
  datasets: DatasetAsset[];
  plans: TrainingPlan[];
  jobs: TrainingJob[];
  exports: ExportArtifact[];
}
