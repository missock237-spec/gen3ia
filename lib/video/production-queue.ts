import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 20 : file de PRODUCTION AUTOPILOTE (Task 1-a FIX 7).
 *
 * Le dos de l'intégration chat/agent : à partir d'UN prompt utilisateur,
 * cette file enchaîne TOUTE la chaîne de production réelle — création du
 * projet, plan du Directeur, scénario, visuels (Consistency Engine), voix,
 * rendu (file de rendu module 19) — une ÉTAPE par tick, re-file via QStash
 * (pattern PATH BRUT → repli encodé partagé) ET continuation par sondage
 * (GET production) pour fonctionner SANS QStash.
 *
 * Architecture strictement miroir de render-queue (module 19) :
 * - claim TRANSACTIONNEL Firestore avec bail (leaseOwner + leaseExpiresAt) :
 *   deux ticks/polls concurrents ne peuvent pas travailler le même job ;
 * - budget de relance `retryCount` distinct du compteur informatif
 *   `attempts` (un job de 40 ticks garde ses 3 relances) ;
 * - progression STOCKÉE en 0..1 (contrat UI ×100) pondérée par étapes ;
 * - checkpoints sceneCursor : les visuels/narrations reprennent là où ils
 *   se sont arrêtés, jamais de re-génération complète ;
 * - facturation EXISTANTE honorée : billImageGeneration (visuels générés),
 *   billTts (caractères ElevenLabs réels) — le rendu réserve/règle/libère
 *   son propre budget via startRenderJob.
 */

import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { publishJsonDestination, type QStashPublishResult } from "@/lib/queue/qstash";
import { createProject, getOwnedProjectOrThrow, patchProject, logSystem } from "@/lib/video/project-service";
import { VideoProjectCreateSchema, DirectorBriefSchema, RenderRequestSchema } from "@/lib/video/security";
import { applyProductionPlan } from "@/lib/video/director-service";
import { generateScript } from "@/lib/video/script-service";
import { generateSceneImage } from "@/lib/video/image-bridge";
import { billImageGeneration, billTts } from "@/lib/video/credits";
import { resolvePreferredVoice, generateSceneNarration, attachRecordingAsNarration } from "@/lib/video/voice-service";
import { listAssets } from "@/lib/video/asset-service";
import { syncVoiceTrack, applyTimelinePatch } from "@/lib/video/timeline-service";
import { ensureMusicBed } from "@/lib/video/audio-engine";
import { isOwnedVideoKey } from "@/lib/video/storage";
import { startRenderJob, getJob } from "@/lib/video/render-queue";
import type { VideoExportTarget, VideoProject } from "@/lib/video/types";

export const PRODUCTION_JOBS_COLLECTION = "videoProductionJobs";

export const PRODUCTION_STAGES = ["project", "plan", "script", "assets", "voice", "render", "done"] as const;
export type ProductionStage = (typeof PRODUCTION_STAGES)[number];

export const PRODUCTION_JOB_STATUSES = ["queued", "processing", "completed", "failed", "cancelled"] as const;
export type ProductionJobStatus = (typeof PRODUCTION_JOB_STATUSES)[number];

/**
 * Progression par étape — CONTRAT STOCKÉ 0..1 (l'UI multiplie par 100) :
 * project 2 %, plan 10 %, script 18 %, assets 18→70 % (par scène),
 * voice 70→80 %, render 80→98 % (miroir du job de rendu), done 100 %.
 */
export const PRODUCTION_STAGE_WEIGHTS: Record<ProductionStage, [number, number]> = {
  project: [0, 0.02],
  plan: [0.02, 0.12],
  script: [0.12, 0.3],
  assets: [0.3, 0.7],
  voice: [0.7, 0.8],
  render: [0.8, 0.98],
  done: [0.98, 1],
};

/** Budget de RELANCE après échec d'étape (distinct du compteur informatif). */
export const PRODUCTION_RETRY_BUDGET = 3;
/** Visuels/narrations traités par tick au maximum (bornage serverless). */
export const ASSET_BATCH_SIZE = 4;
/** Bail d'un tick de production (mêmes échéances que le rendu). */
export const PRODUCTION_LEASE_MS = 230_000;
/** Budget de travail par défaut d'une avance « sondage » (GET responsive). */
export const PRODUCTION_POLL_ADVANCE_BUDGET_MS = 55_000;

export interface ProductionStageTimelineEntry {
  stage: ProductionStage;
  startedAt?: string;
  finishedAt?: string;
  detail?: string;
}

export interface ProductionJobOptions {
  aspectRatio?: VideoProject["aspectRatio"];
  resolution?: VideoProject["resolution"];
  language?: string;
  targetDurationSec?: number;
  style?: string;
  audience?: string;
  platform?: string;
  /** false → pas de narration (vidéo muette assumée). Défaut : tentative avec voix. */
  voiceEnabled?: boolean;
  /** false → sous-titres désactivés sur la timeline avant rendu. */
  subtitlesEnabled?: boolean;
  /** Formats dérivés à produire après le master (validés RenderRequestSchema). */
  derivedTargets?: VideoExportTarget[];
}

export interface VideoProductionJob {
  id: string;
  userId: string;
  projectId: string;
  prompt: string;
  title: string;
  options?: ProductionJobOptions;
  status: ProductionJobStatus;
  stage: ProductionStage;
  stageIndex: number;
  /** 0..1 — progression pondérée (contrat UI ×100). */
  progress: number;
  /** Curseur de lot : index de la PROCHAINE scène à traiter (assets/voice). */
  sceneCursor: number;
  error?: string;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  renderJobId?: string;
  /** Compteur informatif de ticks pris en charge. */
  attempts: number;
  /** Budget de relance après échec (sature à PRODUCTION_RETRY_BUDGET). */
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  timeline: ProductionStageTimelineEntry[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 10_000) / 10_000));
}

/**
 * Progression d'un job de production (contrat 0..1) — interpolée DANS
 * l'étape courante : completed/total (scènes traitées, progression miroir
 * du rendu…) ; total = 0 → début d'étape (1 pour `done`).
 */
export function computeProductionProgress(stage: ProductionStage, completed: number, total: number): number {
  const [start, end] = PRODUCTION_STAGE_WEIGHTS[stage];
  const safeTotal = Math.max(0, total);
  const ratio = safeTotal > 0 ? Math.min(1, Math.max(0, completed / safeTotal)) : stage === "done" ? 1 : 0;
  return clamp01(start + (end - start) * ratio);
}

export interface AssetWindow<T> {
  /** Lot à traiter (≤ batchSize) — reprise où le curseur s'est arrêté. */
  batch: T[];
  /** Curseur APRÈS traitement du lot (checkpoint). */
  nextCursor: number;
  /** true si tout est déjà traité (cursor au bout). */
  done: boolean;
  /** Reste à traiter APRÈS ce lot. */
  remaining: number;
}

/**
 * Math de reprise des lots (sceneCursor) — pure, testée : un curseur
 * tronqué/négatif (document historique corrompu) est borné, jamais OOB.
 */
export function nextAssetWindow<T>(items: readonly T[], cursor: number, batchSize: number): AssetWindow<T> {
  const safeBatch = Math.max(1, Math.floor(batchSize));
  const safeCursor = Math.max(0, Math.min(Math.floor(cursor), items.length));
  const batch = items.slice(safeCursor, safeCursor + safeBatch);
  const nextCursor = safeCursor + batch.length;
  return { batch, nextCursor, done: nextCursor >= items.length, remaining: Math.max(0, items.length - nextCursor) };
}

// ────────────────────────────────────────────────────────────────────────────
// Création d'un job (entrée chat/agent — outil video.create)
// ────────────────────────────────────────────────────────────────────────────

export interface CreateVideoProductionJobParams {
  userId: string;
  /** Brief créatif complet (même validation que POST .../plan). */
  prompt: string;
  title?: string;
  options?: ProductionJobOptions;
  /**
   * Origine de l'app (dérivation de l'URL receiver QStash). Absente dans le
   * contexte agent : GEN3IA_APP_ORIGIN est utilisée, sinon la continuation
   * se fait par sondage (GET production) — jamais d'échec bloquant.
   */
  origin?: string;
}

export interface CreateVideoProductionJobResult {
  jobId: string;
  projectId: string;
  status: "queued";
  stage: ProductionStage;
  /** Mode de continuation effectif : QStash si configuré, sinon sondage. */
  queueMode: "qstash" | "poll";
}

function deriveTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const cleaned = firstLine.replace(/^[#>*\-\s]+/, "").replace(/["'`]/g, "").trim();
  const base = cleaned.length >= 3 ? cleaned.slice(0, 60) : "Vidéo Gen3ia";
  return base.length < 3 ? "Vidéo Gen3ia" : base;
}

/**
 * Crée le projet vidéo (MÊME chemin que POST /api/video/projects :
 * VideoProjectCreateSchema + createProject), puis le job de production,
 * puis publie le premier tick via le publisher corrigé (path brut → repli
 * encodé). QStash absent n'est PAS une erreur : le résultat porte le mode
 * de continuation effectif (sondage) et l'appelant peut en informer l'IA.
 */
export async function createVideoProductionJob(params: CreateVideoProductionJobParams): Promise<CreateVideoProductionJobResult> {
  const brief = DirectorBriefSchema.parse({ brief: params.prompt }).brief;
  const title = params.title?.trim() || deriveTitle(brief);

  // Même validation que POST /api/video/projects (les clés inconnues comme
  // voiceEnabled/subtitlesEnabled sont retirées par le schéma — elles
  // restent portées par job.options pour les étapes voix/rendu).
  const projectInput = VideoProjectCreateSchema.parse({
    ...(params.options ?? {}),
    title,
    description: params.options?.audience ? `Brief : ${brief.slice(0, 1500)}` : brief.slice(0, 2000),
  });
  const project = await createProject(params.userId, projectInput);

  const derivedTargets = params.options?.derivedTargets
    ? RenderRequestSchema.parse({ derivedTargets: params.options.derivedTargets }).derivedTargets
    : [];

  const jobId = randomUUID();
  const now = nowIso();
  const job: VideoProductionJob = {
    id: jobId,
    userId: params.userId,
    projectId: project.id,
    prompt: brief,
    title,
    options: { ...(params.options ?? {}), derivedTargets },
    status: "queued",
    stage: "project",
    stageIndex: 0,
    progress: 0,
    sceneCursor: 0,
    attempts: 0,
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
    timeline: [],
  };
  await adminDb.collection(PRODUCTION_JOBS_COLLECTION).doc(jobId).create({ ...job });
  await logSystem(project.id, `Production autopilote ${jobId.slice(0, 8)} enfile (prompt : ${brief.slice(0, 120)}).`).catch(() => undefined);

  const origin = params.origin?.trim() || process.env.GEN3IA_APP_ORIGIN?.trim() || "";
  const published = origin ? await publishProductionTick(origin, jobId) : ({ ok: false, mode: "unconfigured" } as const);
  if (!published.ok && published.mode === "error") {
    // PAS d'échec bloquant : continuation par sondage (GET production) —
    // mais l'incident est journalisé (jamais de fantôme silencieux).
    await logSystem(project.id, `Continuation QStash indisponible (${published.message.slice(0, 200)}) — avancement par sondage du studio.`).catch(() => undefined);
  }

  return { jobId, projectId: project.id, status: "queued", stage: "project", queueMode: published.ok ? "qstash" : "poll" };
}

// ────────────────────────────────────────────────────────────────────────────
// Publication QStash (même pattern corrigé que le rendu)
// ────────────────────────────────────────────────────────────────────────────

export function productionTickUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/video/worker/production-tick`;
}

export async function publishProductionTick(origin: string, jobId: string, delaySeconds = 1): Promise<QStashPublishResult> {
  return publishJsonDestination(productionTickUrl(origin), JSON.stringify({ jobId }), { delaySeconds });
}

async function publishTickAndLog(job: Pick<VideoProductionJob, "id" | "projectId">, origin: string, delaySeconds = 0): Promise<boolean> {
  if (!origin) return false;
  const published = await publishProductionTick(origin, job.id, delaySeconds);
  if (!published.ok && published.mode === "error") {
    await logSystem(job.projectId, `Continuation QStash échouée (${published.message.slice(0, 200)}) — reprise par sondage du studio.`).catch(() => undefined);
  }
  return published.ok;
}

// ────────────────────────────────────────────────────────────────────────────
// Claim transactionnel + bail (miroir exact du rendu)
// ────────────────────────────────────────────────────────────────────────────

type ProductionClaimOutcome =
  | { kind: "claimed"; job: VideoProductionJob }
  | { kind: "missing" }
  | { kind: "terminal"; job: VideoProductionJob }
  | { kind: "lease-held"; job: VideoProductionJob };

function leaseActive(job: VideoProductionJob, now: number): boolean {
  return typeof job.leaseExpiresAt === "number" && job.leaseExpiresAt > now;
}

/** Normalise un document Firestore (compatibilité champs manquants). */
function normalizeJobDoc(stored: Partial<VideoProductionJob>, id: string): VideoProductionJob {
  return {
    id,
    userId: stored.userId ?? "",
    projectId: stored.projectId ?? "",
    prompt: stored.prompt ?? "",
    title: stored.title ?? "",
    ...(stored.options ? { options: stored.options } : {}),
    status: stored.status ?? "queued",
    stage: stored.stage ?? "project",
    stageIndex: typeof stored.stageIndex === "number" ? stored.stageIndex : 0,
    progress: typeof stored.progress === "number" && stored.progress >= 0 && stored.progress <= 1 ? stored.progress : 0,
    sceneCursor: typeof stored.sceneCursor === "number" ? stored.sceneCursor : 0,
    ...(stored.error ? { error: stored.error } : {}),
    ...(stored.leaseOwner ? { leaseOwner: stored.leaseOwner } : {}),
    ...(typeof stored.leaseExpiresAt === "number" ? { leaseExpiresAt: stored.leaseExpiresAt } : {}),
    ...(stored.renderJobId ? { renderJobId: stored.renderJobId } : {}),
    attempts: typeof stored.attempts === "number" ? stored.attempts : 0,
    retryCount: typeof stored.retryCount === "number" ? stored.retryCount : 0,
    createdAt: stored.createdAt ?? nowIso(),
    updatedAt: stored.updatedAt ?? nowIso(),
    timeline: Array.isArray(stored.timeline) ? stored.timeline : [],
  };
}

async function claimProductionJob(jobId: string): Promise<ProductionClaimOutcome> {
  return adminDb.runTransaction(async (tx) => {
    const ref = adminDb.collection(PRODUCTION_JOBS_COLLECTION).doc(jobId);
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return { kind: "missing" } as const;
    const job = normalizeJobDoc((snapshot.data() ?? {}) as Partial<VideoProductionJob>, jobId);
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return { kind: "terminal", job } as const;
    }
    const now = Date.now();
    if (job.status === "processing" && leaseActive(job, now)) {
      return { kind: "lease-held", job } as const;
    }
    const leaseOwner = `${jobId}:${randomUUID()}`;
    const leaseExpiresAt = now + PRODUCTION_LEASE_MS;
    tx.update(ref, {
      status: "processing",
      leaseOwner,
      leaseExpiresAt,
      attempts: job.attempts + 1,
      updatedAt: nowIso(),
    });
    return {
      kind: "claimed",
      job: { ...job, status: "processing", leaseOwner, leaseExpiresAt, attempts: job.attempts + 1 },
    } as const;
  });
}

async function releaseLease(jobId: string): Promise<void> {
  await adminDb.collection(PRODUCTION_JOBS_COLLECTION).doc(jobId).set(
    { leaseOwner: null, leaseExpiresAt: 0, updatedAt: nowIso() },
    { merge: true },
  ).catch(() => undefined);
}

// ────────────────────────────────────────────────────────────────────────────
// Machine d'étapes — UNE étape par tick, re-file jusqu'à complétion
// ────────────────────────────────────────────────────────────────────────────

export interface ProductionTickResult {
  jobId: string;
  projectId: string;
  status: ProductionJobStatus;
  stage: ProductionStage | null;
  progress: number;
  done: boolean;
  continued: boolean;
  renderJobId?: string;
  message: string;
}

type ProductionStageResult =
  | { action: "advance"; detail?: string }
  | { action: "stay"; detail?: string; delaySeconds?: number; mirrorProgress?: number }
  | { action: "terminal-completed" }
  | { action: "terminal-failed"; message: string };

/** Marque le début de l'étape courante dans la timeline du job (idempotent). */
async function ensureStageEntry(job: VideoProductionJob): Promise<void> {
  if (job.timeline.some((e) => e.stage === job.stage)) return;
  const timeline: ProductionStageTimelineEntry[] = [...job.timeline, { stage: job.stage, startedAt: nowIso() }];
  job.timeline = timeline;
  await adminDb.collection(PRODUCTION_JOBS_COLLECTION).doc(job.id).set(
    { timeline, updatedAt: nowIso() },
    { merge: true },
  ).catch(() => undefined);
}

async function moveToNextProductionStage(job: VideoProductionJob, detail?: string): Promise<void> {
  const index = PRODUCTION_STAGES.indexOf(job.stage);
  const next = PRODUCTION_STAGES[Math.min(index + 1, PRODUCTION_STAGES.length - 1)];
  const timeline: ProductionStageTimelineEntry[] = job.timeline.map((e) =>
    e.stage === job.stage && !e.finishedAt ? { ...e, finishedAt: nowIso(), ...(detail ? { detail } : {}) } : e,
  );
  timeline.push({ stage: next, startedAt: nowIso() });
  const patch = {
    stage: next,
    stageIndex: PRODUCTION_STAGES.indexOf(next),
    progress: computeProductionProgress(next, 0, 0),
    sceneCursor: 0,
    timeline,
    updatedAt: nowIso(),
  };
  await adminDb.collection(PRODUCTION_JOBS_COLLECTION).doc(job.id).set(patch, { merge: true });
  job.stage = next;
  job.stageIndex = patch.stageIndex;
  job.progress = patch.progress;
  job.sceneCursor = 0;
  job.timeline = timeline;
}

/** PROJECT : garde-fou — le projet existe et appartient au propriétaire. */
async function stageProject(job: VideoProductionJob): Promise<ProductionStageResult> {
  const project = await getOwnedProjectOrThrow(job.userId, job.projectId);
  return { action: "advance", detail: `Projet « ${project.title} » prêt.` };
}

/** PLAN : Directeur de production (même appel que POST .../plan). */
async function stagePlan(job: VideoProductionJob): Promise<ProductionStageResult> {
  const { plan } = await applyProductionPlan(job.userId, job.projectId, job.prompt);
  const scenes = plan.structure.reduce((n, c) => n + c.sceneCount, 0);
  return { action: "advance", detail: `Plan appliqué : ${plan.structure.length} chapitre(s), ${scenes} scènes, ${Math.round(plan.targetDurationSec / 60)} min.` };
}

/** SCRIPT : Script Engine (même appel que POST .../script). */
async function stageScript(job: VideoProductionJob): Promise<ProductionStageResult> {
  const result = await generateScript(job.userId, job.projectId);
  const sceneCount = result.script?.scenes.length ?? 0;
  return { action: "advance", detail: `Scénario généré : ${sceneCount} scène(s).` };
}

/**
 * ASSETS : visuels de scènes par lots de ≤ ASSET_BATCH_SIZE par tick
 * (per-scene via Image Bridge + Consistency Engine, réutilise les images
 * existantes), sceneCursor checkpoint après CHAQUE scène — reprise là où
 * le tick s'est arrêté. Facturation existante honorée : billImageGeneration
 * sur les images NOUVELLEMENT générées (les réutilisations ne coûtent rien).
 */
async function stageAssets(job: VideoProductionJob, timeBudgetMs?: number): Promise<ProductionStageResult> {
  let project = await getOwnedProjectOrThrow(job.userId, job.projectId);
  if (!project.script) throw new Error("Scénario absent à l'étape des visuels.");
  const scenes = project.script.scenes;
  if (scenes.length === 0) throw new Error("Scénario vide : aucune scène à illustrer.");

  const deadlineMs = typeof timeBudgetMs === "number" && timeBudgetMs > 0 ? Date.now() + timeBudgetMs : null;
  const window = nextAssetWindow(scenes, job.sceneCursor, ASSET_BATCH_SIZE);
  let generated = 0;

  for (const scene of window.batch) {
    if (deadlineMs !== null && Date.now() >= deadlineMs) break;
    const result = await generateSceneImage({ userId: job.userId, project, scene });
    if (result.generated) {
      generated += 1;
      // La bible évolue à chaque référence établie : la scène suivante
      // bénéficie des références fraîches (même comportement que le lot client).
      project = await getOwnedProjectOrThrow(job.userId, job.projectId);
    }
    job.sceneCursor = scenes.findIndex((s) => s.id === scene.id) + 1;
    await adminDb.collection(PRODUCTION_JOBS_COLLECTION).doc(job.id).set(
      {
        sceneCursor: job.sceneCursor,
        progress: computeProductionProgress("assets", job.sceneCursor, scenes.length),
        updatedAt: nowIso(),
      },
      { merge: true },
    );
  }

  if (generated > 0) {
    await billImageGeneration(job.userId, job.projectId, generated);
  }

  if (job.sceneCursor >= scenes.length) {
    return { action: "advance", detail: `${scenes.length} visuel(s) prêt(s) (${generated} généré(s)).` };
  }
  return { action: "stay", detail: `${job.sceneCursor}/${scenes.length} visuels traités.` };
}

/**
 * VOICE : narrations par lots (MÊME chemin que POST .../generate-voice :
 * enregistrement utilisateur ou TTS ElevenLabs facturé au caractère réel),
 * sceneCursor checkpoint par scène. Aucune voix configurée ou narration
 * désactivée → avancement assumé (vidéo muette — le moteur de rendu la
 * gère explicitement) : une production autopilote ne doit pas mourir faute
 * de profil vocal, l'incident est consigné dans la timeline du job.
 */
async function stageVoice(job: VideoProductionJob, timeBudgetMs?: number): Promise<ProductionStageResult> {
  const project = await getOwnedProjectOrThrow(job.userId, job.projectId);
  if (!project.script) throw new Error("Scénario absent à l'étape de la voix.");
  const scenes = project.script.scenes;

  if (job.options?.voiceEnabled === false) {
    return { action: "advance", detail: "Narration désactivée — vidéo muette assumée." };
  }
  const voice = await resolvePreferredVoice(job.userId, project);
  if (!voice) {
    return { action: "advance", detail: "Aucune voix configurée — vidéo muette assumée (narrations ajoutables depuis le studio)." };
  }

  const deadlineMs = typeof timeBudgetMs === "number" && timeBudgetMs > 0 ? Date.now() + timeBudgetMs : null;
  const window = nextAssetWindow(scenes, job.sceneCursor, ASSET_BATCH_SIZE);

  for (const scene of window.batch) {
    if (deadlineMs !== null && Date.now() >= deadlineMs) break;
    // Voie A : enregistrement utilisateur (usage direct de l'échantillon).
    if (voice.origin === "recording" && voice.sampleR2Key && isOwnedVideoKey(job.userId, voice.sampleR2Key)) {
      await attachRecordingAsNarration({
        userId: job.userId,
        projectId: job.projectId,
        sceneId: scene.id,
        sampleR2Key: voice.sampleR2Key,
      });
    } else {
      // Voie B : synthèse ElevenLabs facturée au caractère réel.
      const narration = await generateSceneNarration({
        userId: job.userId,
        projectId: job.projectId,
        sceneId: scene.id,
        narration: scene.narration,
        voice,
      });
      if (narration.charactersUsed > 0) {
        await billTts(job.userId, job.projectId, narration.charactersUsed);
      }
    }
    job.sceneCursor = scenes.findIndex((s) => s.id === scene.id) + 1;
    await adminDb.collection(PRODUCTION_JOBS_COLLECTION).doc(job.id).set(
      {
        sceneCursor: job.sceneCursor,
        progress: computeProductionProgress("voice", job.sceneCursor, scenes.length),
        updatedAt: nowIso(),
      },
      { merge: true },
    );
  }

  if (job.sceneCursor < scenes.length) {
    return { action: "stay", detail: `${job.sceneCursor}/${scenes.length} narration(s).` };
  }

  // Toutes les narrations prêtes : piste VOIX synchronisée + musique posée
  // (identique à la route generate-voice) si la timeline existe déjà —
  // sinon le stade plan du rendu la construira AVEC les narrations.
  if (project.timeline) {
    const narrations = await listAssets(job.userId, job.projectId, "audio_narration");
    const narrationByScene = new Map(narrations.filter((a) => a.sceneId).map((a) => [a.sceneId!, a]));
    let timeline = syncVoiceTrack(
      project.timeline,
      project.script.scenes
        .filter((s) => narrationByScene.has(s.id))
        .map((s) => ({
          sceneId: s.id,
          assetId: narrationByScene.get(s.id)!.id,
          startSec: s.startSec,
          durationSec: Math.min(s.durationSec, narrationByScene.get(s.id)!.media?.durationSec ?? s.durationSec),
        })),
    );
    if (!timeline.musicBed) {
      const bed = await ensureMusicBed(job.userId, job.projectId, project.musicMood ?? "documentaire", timeline.durationSec);
      timeline = applyTimelinePatch(timeline, "set_music_bed", undefined, { assetId: bed.id, volume: 0.6, duckTo: 0.22 });
    }
    await patchProject(job.userId, job.projectId, { timeline });
  }
  return { action: "advance", detail: `${scenes.length} narration(s) prête(s) (voix : ${voice.name}).` };
}

/** RENDER : enfile le rendu réel (module 19) — il gère sa propre facturation. */
async function stageRender(job: VideoProductionJob, origin: string): Promise<ProductionStageResult> {
  const project = await getOwnedProjectOrThrow(job.userId, job.projectId);
  // Option subtitlesEnabled:false → sous-titres coupés sur la timeline.
  if (job.options?.subtitlesEnabled === false && project.timeline?.captions?.enabled) {
    await patchProject(job.userId, job.projectId, {
      timeline: { ...project.timeline, captions: { ...project.timeline.captions, enabled: false } },
    });
  }
  const derivedTargets = job.options?.derivedTargets
    ? RenderRequestSchema.parse({ derivedTargets: job.options.derivedTargets }).derivedTargets
    : [];
  const render = await startRenderJob({ userId: job.userId, projectId: job.projectId, derivedTargets, origin });
  // Rattaché AVANT le passage à l'étape done (visible même si le tick meurt ici).
  await adminDb.collection(PRODUCTION_JOBS_COLLECTION).doc(job.id).set(
    { renderJobId: render.jobId, updatedAt: nowIso() },
    { merge: true },
  );
  job.renderJobId = render.jobId;
  return { action: "advance", detail: `Rendu ${render.jobId.slice(0, 8)} en file.` };
}

/** DONE : miroir du job de rendu — la production ne termine qu'avec lui. */
async function stageDone(job: VideoProductionJob): Promise<ProductionStageResult> {
  if (!job.renderJobId) throw new Error("Aucun job de rendu rattaché à l'étape finale.");
  const renderJob = await getJob(job.renderJobId);
  if (!renderJob) throw new Error(`Job de rendu ${job.renderJobId.slice(0, 8)} introuvable.`);
  if (renderJob.status === "completed") {
    return { action: "terminal-completed" } as const;
  }
  if (renderJob.status === "failed" || renderJob.status === "cancelled") {
    return { action: "terminal-failed", message: renderJob.errorMessage ?? "Rendu annulé." } as const;
  }
  // Rendu en cours : progression miroir (80→98 %) + re-sondage borné.
  return {
    action: "stay",
    mirrorProgress: computeProductionProgress("render", renderJob.progress, 1),
    delaySeconds: 10,
    detail: `Rendu en cours (${Math.round(renderJob.progress * 100)} %).`,
  } as const;
}

/**
 * Fait avancer un job de production d'UNE étape. Claim transactionnel avec
 * bail ; en fin de tick réussi, le bail est libéré AVANT la re-file (le
 * tick suivant — QStash ou sondage — claimr aussitôt). Les échecs passent
 * par le budget retryCount (3) puis échec définitif notifié.
 */
export async function advanceProductionJob(jobId: string, origin: string, options: { timeBudgetMs?: number } = {}): Promise<ProductionTickResult> {
  const outcome = await claimProductionJob(jobId);
  if (outcome.kind === "missing") {
    return { jobId, projectId: "", status: "failed", stage: null, progress: 0, done: true, continued: false, message: "Job de production introuvable." };
  }
  if (outcome.kind === "lease-held") {
    return { jobId, projectId: outcome.job.projectId, status: outcome.job.status, stage: outcome.job.stage, progress: outcome.job.progress, done: false, continued: false, message: "Tick déjà pris en charge par un autre worker (bail actif)." };
  }
  if (outcome.kind === "terminal") {
    const job = outcome.job;
    return {
      jobId,
      projectId: job.projectId,
      status: job.status,
      stage: job.stage,
      progress: job.status === "completed" ? 1 : job.progress,
      done: true,
      continued: false,
      ...(job.renderJobId ? { renderJobId: job.renderJobId } : {}),
      message: job.status === "completed" ? "Production déjà terminée." : job.error ?? (job.status === "cancelled" ? "Production annulée." : "Production terminée."),
    };
  }

  const job = outcome.job;
  try {
    await ensureStageEntry(job);
    let stageResult: ProductionStageResult;
    switch (job.stage) {
      case "project":
        stageResult = await stageProject(job);
        break;
      case "plan":
        stageResult = await stagePlan(job);
        break;
      case "script":
        stageResult = await stageScript(job);
        break;
      case "assets":
        stageResult = await stageAssets(job, options.timeBudgetMs);
        break;
      case "voice":
        stageResult = await stageVoice(job, options.timeBudgetMs);
        break;
      case "render":
        stageResult = await stageRender(job, origin);
        break;
      case "done":
        stageResult = await stageDone(job);
        break;
      default: {
        const exhaustive: never = job.stage;
        throw new Error(`Étape de production inconnue : ${String(exhaustive)}`);
      }
    }
    return await concludeProductionTick(job, stageResult, origin);
  } catch (error) {
    return await failProductionJob(job, error instanceof Error ? error : new Error(String(error)), origin);
  }
}

/** Fin de tick : écrit timeline/progression, libère le bail, re-file. */
async function concludeProductionTick(
  job: VideoProductionJob,
  stageResult: ProductionStageResult,
  origin: string,
): Promise<ProductionTickResult> {
  // Terminaisons (production finie ou échec du rendu rattaché).
  if (stageResult.action === "terminal-completed" || stageResult.action === "terminal-failed") {
    const failed = stageResult.action === "terminal-failed";
    const message = failed ? stageResult.message : "Vidéo livrée.";
    const timeline: ProductionStageTimelineEntry[] = job.timeline.map((e) =>
      e.stage === "done" && !e.finishedAt ? { ...e, finishedAt: nowIso(), detail: message } : e,
    );
    await adminDb.collection(PRODUCTION_JOBS_COLLECTION).doc(job.id).set(
      {
        status: failed ? "failed" : "completed",
        ...(failed ? { error: message } : {}),
        progress: failed ? job.progress : 1,
        timeline,
        leaseOwner: null,
        leaseExpiresAt: 0,
        updatedAt: nowIso(),
      },
      { merge: true },
    );
    if (failed) {
      await logSystem(job.projectId, `Production ${job.id.slice(0, 8)} ÉCHOUÉE : ${message}`).catch(() => undefined);
    } else {
      await logSystem(job.projectId, `Production ${job.id.slice(0, 8)} TERMINÉE — vidéo livrée.`).catch(() => undefined);
    }
    return {
      jobId: job.id,
      projectId: job.projectId,
      status: failed ? "failed" : "completed",
      stage: "done",
      progress: failed ? job.progress : 1,
      done: true,
      continued: false,
      ...(job.renderJobId ? { renderJobId: job.renderJobId } : {}),
      message,
    };
  }

  // Bail libéré AVANT toute re-file — le tick suivant doit pouvoir claimr.
  await releaseLease(job.id);

  if (stageResult.action === "advance") {
    const finishedStage = job.stage;
    await moveToNextProductionStage(job, stageResult.detail);
    const enqueued = await publishTickAndLog(job, origin);
    return {
      jobId: job.id,
      projectId: job.projectId,
      status: "processing",
      stage: job.stage,
      progress: job.progress,
      done: false,
      continued: enqueued,
      ...(job.renderJobId ? { renderJobId: job.renderJobId } : {}),
      message: stageResult.detail ?? `Étape ${finishedStage} terminée.`,
    };
  }

  // "stay" : travail partiel (lot de visuels/narrations) ou re-sondage du rendu.
  if (typeof stageResult.mirrorProgress === "number") {
    await adminDb.collection(PRODUCTION_JOBS_COLLECTION).doc(job.id).set(
      { progress: stageResult.mirrorProgress, updatedAt: nowIso() },
      { merge: true },
    );
    job.progress = stageResult.mirrorProgress;
  }
  const enqueued = await publishTickAndLog(job, origin, stageResult.delaySeconds ?? 0);
  return {
    jobId: job.id,
    projectId: job.projectId,
    status: "processing",
    stage: job.stage,
    progress: job.progress,
    done: false,
    continued: enqueued,
    ...(job.renderJobId ? { renderJobId: job.renderJobId } : {}),
    message: stageResult.detail ?? `Étape ${job.stage} en cours.`,
  };
}

/**
 * Échec d'un tick de production : budget retryCount (3) puis échec
 * définitif. Aucune réservation à libérer au niveau production : les
 * images/TTS sont facturés au réel au fil de l'eau et le job de rendu
 * (réservé séparément) libère son propre budget sur son propre échec.
 */
async function failProductionJob(job: VideoProductionJob, error: Error, origin?: string): Promise<ProductionTickResult> {
  const message = error.message.slice(0, 800);
  const retryCount = typeof job.retryCount === "number" ? job.retryCount : 0;
  if (retryCount < PRODUCTION_RETRY_BUDGET) {
    await adminDb.collection(PRODUCTION_JOBS_COLLECTION).doc(job.id).set(
      {
        status: "queued",
        error: message,
        retryCount: retryCount + 1,
        leaseOwner: null,
        leaseExpiresAt: 0,
        updatedAt: nowIso(),
      },
      { merge: true },
    );
    if (origin) await publishTickAndLog(job, origin, 20);
    await logSystem(job.projectId, `Production ${job.id.slice(0, 8)} : incident à l'étape ${job.stage} (relance ${retryCount + 1}/${PRODUCTION_RETRY_BUDGET}) — reprise automatique. ${message}`).catch(() => undefined);
    return {
      jobId: job.id,
      projectId: job.projectId,
      status: "queued",
      stage: job.stage,
      progress: job.progress,
      done: false,
      continued: Boolean(origin),
      ...(job.renderJobId ? { renderJobId: job.renderJobId } : {}),
      message,
    };
  }
  await adminDb.collection(PRODUCTION_JOBS_COLLECTION).doc(job.id).set(
    {
      status: "failed",
      error: message,
      leaseOwner: null,
      leaseExpiresAt: 0,
      updatedAt: nowIso(),
    },
    { merge: true },
  );
  await logSystem(job.projectId, `Production ${job.id.slice(0, 8)} ÉCHOUÉE à l'étape ${job.stage} : ${message}`).catch(() => undefined);
  const { createNotification } = await import("@/lib/notifications/repository");
  await createNotification({
    userId: job.userId,
    type: "info",
    title: "Production vidéo échouée",
    body: `La production autopilote a échoué à l'étape « ${job.stage} » : ${message.slice(0, 200)} Les étapes déjà produites restent dans le studio vidéo.`,
  }).catch(() => undefined);
  return {
    jobId: job.id,
    projectId: job.projectId,
    status: "failed",
    stage: job.stage,
    progress: job.progress,
    done: true,
    continued: false,
    ...(job.renderJobId ? { renderJobId: job.renderJobId } : {}),
    message,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Sweeper + continuation par sondage (miroir du rendu)
// ────────────────────────────────────────────────────────────────────────────

export interface ProductionSweepResult {
  scanned: number;
  requeued: number;
  failed: number;
}

/**
 * Jobs « processing » dont le bail/échéance est dépassé : re-file (ou
 * échec définitif après budget) via failProductionJob — idempotent, ne
 * touche jamais un job vivant.
 */
export async function sweepStaleProductionJobs(origin?: string): Promise<ProductionSweepResult> {
  const snap = await adminDb.collection(PRODUCTION_JOBS_COLLECTION).where("status", "==", "processing").get();
  const now = Date.now();
  let requeued = 0;
  let failed = 0;
  for (const doc of snap.docs) {
    const job = normalizeJobDoc((doc.data() ?? {}) as Partial<VideoProductionJob>, doc.id);
    if (leaseActive(job, now)) continue;
    // Sans bail (document historique), l'ancienneté updatedAt tranche (2× bail).
    if (typeof job.leaseExpiresAt !== "number" || job.leaseExpiresAt <= 0) {
      const age = now - Date.parse(job.updatedAt || job.createdAt);
      if (!(Number.isFinite(age) && age > 2 * PRODUCTION_LEASE_MS)) continue;
    }
    const result = await failProductionJob(job, new Error("Échéance de traitement dépassée (worker interrompu) — reprise à l'étape courante."), origin);
    if (result.status === "queued") requeued += 1;
    else failed += 1;
  }
  return { scanned: snap.docs.length, requeued, failed };
}

/**
 * Continuation par SONDAGE : fait avancer d'UN tick un job en attente dans
 * la requête de polling (GET production) — la production avance même sans
 * QStash tant que le client garde la page ouverte. Le claim transactionnel
 * empêche les sondages concurrents de doubler un tick QStash.
 */
export async function maybeAdvancePendingProductionJob(jobId: string, options: { origin: string; timeBudgetMs?: number }): Promise<ProductionTickResult | null> {
  const snap = await adminDb.collection(PRODUCTION_JOBS_COLLECTION).doc(jobId).get();
  if (!snap.exists) return null;
  const job = normalizeJobDoc((snap.data() ?? {}) as Partial<VideoProductionJob>, jobId);
  if (job.status === "queued") {
    return advanceProductionJob(jobId, options.origin, { timeBudgetMs: options.timeBudgetMs });
  }
  if (job.status === "processing" && !leaseActive(job, Date.now())) {
    return advanceProductionJob(jobId, options.origin, { timeBudgetMs: options.timeBudgetMs });
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Lectures (routes propriétaire-scopées)
// ────────────────────────────────────────────────────────────────────────────

export async function getProductionJob(jobId: string): Promise<VideoProductionJob | null> {
  const snap = await adminDb.collection(PRODUCTION_JOBS_COLLECTION).doc(jobId).get();
  if (!snap.exists) return null;
  return normalizeJobDoc((snap.data() ?? {}) as Partial<VideoProductionJob>, jobId);
}

/** Dernier job de production du projet (le plus récent d'abord). */
export async function listProductionJobs(userId: string, projectId?: string): Promise<VideoProductionJob[]> {
  const snap = await adminDb.collection(PRODUCTION_JOBS_COLLECTION).where("userId", "==", userId).get();
  const jobs = snap.docs
    .map((d) => normalizeJobDoc((d.data() ?? {}) as Partial<VideoProductionJob>, d.id))
    .filter((j) => !projectId || j.projectId === projectId);
  jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return jobs;
}
