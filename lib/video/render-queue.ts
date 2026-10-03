import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 19 : Render Queue + orchestrateur de
 * production (spec §19).
 *
 * File de rendu avec états QUEUED/PROCESSING/PAUSED/FAILED/CANCELLED/
 * COMPLETED, étapes idempotentes, CHECKPOINTS (reprise au segment N après
 * un échec à 73 % — jamais de re-rendu complet), continuation arrière-plan
 * via QStash (le rendu survit aux fermetures d'onglets et aux échéances
 * serverless), annulation, pause/reprise, nettoyage du tmp, facturation
 * reserve→settle/release et notification de livraison.
 */

import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import type {
  RenderJob,
  RenderJobStatus,
  RenderPlan,
  RenderStage,
  VideoAsset,
  SfxName,
  VideoExportTarget,
} from "@/lib/video/types";
import { getOwnedProjectOrThrow, logSystem, setProjectStatus } from "@/lib/video/project-service";
import { getAsset, listAssets } from "@/lib/video/asset-service";
import { buildRenderPlan, buildAssForRender, buildShortsAss, renderDimensions } from "@/lib/video/render/planner";
import {
  renderSegments,
  assembleTransitions,
  mixAudio,
  finalizeMaster,
  renderExportFormat,
  uploadMaster,
  cleanupJob,
  createJobTmpDir,
  type EngineIo,
} from "@/lib/video/render/engine";
import { materializeForRender, uploadVideoAsset } from "@/lib/video/storage";
import { analyzeRenderedMaster, decideAutoFix } from "@/lib/video/qc-service";
import { estimateRenderCost, reserveRenderBudget, settleRenderBudget, releaseRenderBudget, settleExportsBudget } from "@/lib/video/credits";
import { assembleRecursive } from "@/lib/video/long-video-service";
import { VIDEO_LIMITS, VideoQuotaError, MAX_AUTO_FIX_ROUNDS } from "@/lib/video/security";
import { createNotification } from "@/lib/notifications/repository";
import { ensureAudioAssetsForProject } from "@/lib/video/audio-engine";

export const JOBS_COLLECTION = "videoRenderJobs";

const STAGE_PROGRESS: Record<RenderStage, [number, number]> = {
  plan: [0, 5],
  download: [5, 8],
  segments: [8, 73],
  transitions: [73, 78],
  audio: [78, 86],
  subtitles: [86, 90],
  qc: [90, 95],
  exports: [95, 99],
  finalize: [99, 100],
};

const STAGE_ORDER: RenderStage[] = ["plan", "download", "segments", "transitions", "audio", "subtitles", "qc", "exports", "finalize"];

/** Segments rendus par tick (bornage serverless — le reste via continuation). */
const MAX_SEGMENTS_PER_TICK = 3;
/** Échéance d'un tick au-delà de laquelle on re-file le job (continuation). */
const TICK_DEADLINE_MS = 230_000;

function nowIso(): string {
  return new Date().toISOString();
}
// ────────────────────────────────────────────────────────────────────────────
// Démarrage d'un rendu
// ────────────────────────────────────────────────────────────────────────────

export async function startRenderJob(params: {
  userId: string;
  projectId: string;
  derivedTargets: VideoExportTarget[];
  origin: string;
}): Promise<{ jobId: string; queued: boolean; estimate: ReturnType<typeof estimateRenderCost> }> {
  const project = await getOwnedProjectOrThrow(params.userId, params.projectId);
  if (!project.script || project.script.scenes.length === 0) {
    throw new Error("Aucun scénario à monter — générez d'abord le scénario.");
  }
  const images = await listAssets(params.userId, params.projectId, "image");
  const sceneImages = images.filter((a) => a.role?.startsWith("scene:"));
  if (sceneImages.length === 0) {
    throw new Error("Aucune image de scène — générez d'abord les visuels (generate-assets).");
  }

  // Limite de rendus concurrents.
  const running = await countRunningRenders(params.userId);
  if (running >= VIDEO_LIMITS.maxConcurrentRenders) {
    throw new VideoQuotaError(`Vous avez déjà ${running} rendu(s) en cours (limite ${VIDEO_LIMITS.maxConcurrentRenders}). Pausez-en un ou attendez la fin.`);
  }

  const expectedSec = project.script.estimatedDurationSec || project.targetDurationSec;
  const estimate = estimateRenderCost({ durationSec: expectedSec, resolution: project.resolution });
  const jobId = randomUUID();

  // Réservation du budget (fail-closed si solde insuffisant).
  await reserveRenderBudget(params.userId, jobId, estimate);

  const job: RenderJob = {
    id: jobId,
    projectId: params.projectId,
    userId: params.userId,
    status: "queued",
    stage: "plan",
    progress: 0,
    checkpoints: {
      downloadedAssetIds: [],
      completedSegments: [],
      transitionPass: 0,
      transitionsDone: false,
      audioDone: false,
      subtitlesDone: false,
      qcDone: false,
      exportsDone: [],
    },
    mode: "full",
    autoFixRounds: 0,
    attempts: 0,
    exports: params.derivedTargets.map((target) => ({ target, r2Key: "", sizeBytes: 0, status: "pending" })),
    billedMinor: estimate.amountMinor,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await adminDb.collection(JOBS_COLLECTION).doc(jobId).create({ ...job });
  await setProjectStatus(params.userId, params.projectId, "rendering");
  await logSystem(params.projectId, `Rendu ${jobId.slice(0, 8)} mis en file (estimation ${estimate.amountMinor} minor, ${Math.round(expectedSec)} s).`);
  await publishVideoTick(params.origin, jobId);
  return { jobId, queued: true, estimate };
}

async function countRunningRenders(userId: string): Promise<number> {
  const snap = await adminDb.collection(JOBS_COLLECTION).where("userId", "==", userId).get();
  return snap.docs.filter((d) => {
    const s = d.data()?.status;
    return s === "processing" || s === "queued";
  }).length;
}

// ────────────────────────────────────────────────────────────────────────────
// Publication QStash (continuation arrière-plan)
// ────────────────────────────────────────────────────────────────────────────

export function videoTickUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/video/worker/tick`;
}

export async function publishVideoTick(origin: string, jobId: string, delaySeconds = 1): Promise<boolean> {
  const token = process.env.QSTASH_TOKEN?.trim();
  if (!token) return false;
  try {
    const response = await fetch(`https://qstash.upstash.io/v2/publish/${encodeURIComponent(videoTickUrl(origin))}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Upstash-Retries": "3",
        ...(delaySeconds > 0 ? { "Upstash-Delay": `${delaySeconds}s` } : {}),
      },
      body: JSON.stringify({ jobId }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Reprise : remet un job en file et le re-file (utilisateur ou worker). */
export async function resumeJob(userId: string, jobId: string, origin?: string): Promise<void> {
  const job = await getOwnedJobOrThrow(userId, jobId);
  if (job.status !== "paused" && job.status !== "failed" && job.status !== "cancelled") {
    throw new Error(`Reprise impossible depuis l'état ${job.status}.`);
  }
  await adminDb.collection(JOBS_COLLECTION).doc(jobId).set(
    { status: "queued", errorMessage: null, errorCode: null, attempts: FieldValue.increment(1), updatedAt: nowIso() },
    { merge: true },
  );
  if (origin) await publishVideoTick(origin, jobId);
}

export async function pauseJob(userId: string, jobId: string): Promise<void> {
  const job = await getOwnedJobOrThrow(userId, jobId);
  if (job.status !== "processing" && job.status !== "queued") throw new Error(`Pause impossible depuis l'état ${job.status}.`);
  await adminDb.collection(JOBS_COLLECTION).doc(jobId).set({ status: "paused", updatedAt: nowIso() }, { merge: true });
}

export async function cancelJob(userId: string, jobId: string): Promise<void> {
  const job = await getOwnedJobOrThrow(userId, jobId);
  if (job.status === "completed") throw new Error("Rendu déjà terminé.");
  await adminDb.collection(JOBS_COLLECTION).doc(jobId).set({ status: "cancelled", updatedAt: nowIso() }, { merge: true });
  if (job.billedMinor > 0) {
    await releaseRenderBudget(job.userId, job.id, job.billedMinor).catch(() => undefined);
    await adminDb.collection(JOBS_COLLECTION).doc(jobId).set({ billedMinor: 0 }, { merge: true });
  }
  await cleanupJobTmp(jobId);
  await setProjectStatus(userId, job.projectId, "storyboarded").catch(() => undefined);
  await logSystem(job.projectId, `Rendu ${jobId.slice(0, 8)} annulé — réservation libérée.`);
}

export async function listJobs(userId: string, projectId?: string): Promise<RenderJob[]> {
  const snap = await adminDb.collection(JOBS_COLLECTION).where("userId", "==", userId).get();
  const jobs = snap.docs.map((d) => d.data() as RenderJob).filter((j) => !projectId || j.projectId === projectId);
  jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return jobs;
}

export async function getOwnedJobOrThrow(userId: string, jobId: string): Promise<RenderJob> {
  const snap = await adminDb.collection(JOBS_COLLECTION).doc(jobId).get();
  if (!snap.exists) throw new Error("Rendu introuvable.");
  const job = snap.data() as RenderJob;
  if (job.userId !== userId) throw new Error("Rendu introuvable.");
  return job;
}

async function cleanupJobTmp(jobId: string): Promise<void> {
  const snap = await adminDb.collection(JOBS_COLLECTION).doc(jobId).get();
  if (!snap.exists) return;
  const job = snap.data() as RenderJob;
  await cleanupJob(job);
  await adminDb.collection(JOBS_COLLECTION).doc(jobId).set({ tmpDir: null }, { merge: true });
}

// ────────────────────────────────────────────────────────────────────────────
// Machine d'étapes — un tick avance d'une étape (ou d'un lot de segments)
// ────────────────────────────────────────────────────────────────────────────

export interface TickResult {
  jobId: string;
  status: RenderJobStatus;
  stage: RenderStage | null;
  done: boolean;
  continued: boolean;
  message: string;
}

/**
 * Fait avancer un job d'une étape. Idempotent : chaque étape vérifie ses
 * checkpoints. En fin d'échéance (ou après MAX_SEGMENTS_PER_TICK), re-file
 * un tick QStash (continuation) — le rendu ne dépend d'aucun onglet ouvert.
 */
export async function advanceJob(jobId: string, origin: string): Promise<TickResult> {
  const snap = await adminDb.collection(JOBS_COLLECTION).doc(jobId).get();
  if (!snap.exists) return { jobId, status: "failed", stage: null, done: true, continued: false, message: "Job introuvable." };
  const job = snap.data() as RenderJob;

  if (job.status === "cancelled" || job.status === "paused") {
    return { jobId, status: job.status, stage: job.stage, done: true, continued: false, message: `Job ${job.status}.` };
  }
  if (job.status === "completed") {
    return { jobId, status: job.status, stage: job.stage, done: true, continued: false, message: "Déjà terminé." };
  }
  if (job.status === "failed") {
    return { jobId, status: job.status, stage: job.stage, done: true, continued: false, message: job.errorMessage ?? "Échec." };
  }

  // Prise de possession atomique du job (un seul worker à la fois).
  const claimed = await adminDb.collection(JOBS_COLLECTION).doc(jobId).set(
    { status: "processing", deadlineAt: new Date(Date.now() + TICK_DEADLINE_MS).toISOString(), attempts: FieldValue.increment(1), updatedAt: nowIso() },
    { merge: true },
  ).then(() => true).catch(() => false);
  if (!claimed) return { jobId, status: job.status, stage: job.stage, done: false, continued: false, message: "Claim impossible." };

  job.status = "processing";
  job.attempts += 1; // le claim a incrémenté en base — miroir local pour la logique de relance
  // Jobs d'EXPORT SEUL : sautent la production, démarrent à l'étape exports.
  if (job.mode === "exports_only" && STAGE_ORDER.indexOf(job.stage) < STAGE_ORDER.indexOf("exports")) {
    await adminDb.collection(JOBS_COLLECTION).doc(jobId).set({ stage: "exports", updatedAt: nowIso() }, { merge: true });
    job.stage = "exports";
  }
  const tmpDir = job.tmpDir ?? (await createJobTmpDir(jobId));
  if (tmpDir !== job.tmpDir) {
    await adminDb.collection(JOBS_COLLECTION).doc(jobId).set({ tmpDir, updatedAt: nowIso() }, { merge: true });
    job.tmpDir = tmpDir;
  }

  const io = buildEngineIo(job, tmpDir);
  const startedStage = job.stage;

  try {
    switch (job.stage) {
      case "plan":
        await stagePlan(job, io);
        break;
      case "download":
        await stageDownload(job, io);
        break;
      case "segments":
        return await stageSegments(job, io, origin);
      case "transitions":
        await stageTransitions(job, io);
        break;
      case "audio":
        await stageAudio(job, io);
        break;
      case "subtitles":
        await stageSubtitles(job);
        break;
      case "qc":
        return await stageQc(job, io, origin);
      case "exports":
        return await stageExports(job, io, origin);
      case "finalize":
        return await stageFinalize(job, io, origin);
      default: {
        const exhaustive: never = job.stage;
        throw new Error(`Étape inconnue : ${String(exhaustive)}`);
      }
    }
    await moveToNextStage(jobId, job, startedStage);
    // Continuation immédiate si l'échéance approche, sinon tick suivant.
    const deadlineSoon = Date.now() + 30_000 > Date.parse(job.deadlineAt ?? "0");
    const enqueued = await publishVideoTick(origin, jobId, deadlineSoon ? 1 : 0);
    const refreshed = await refreshJob(jobId);
    return { jobId, status: refreshed.status, stage: refreshed.stage, done: false, continued: enqueued, message: `Étape ${startedStage} terminée.` };
  } catch (error) {
    return await failJob(job, error instanceof Error ? error : new Error(String(error)), origin);
  }
}

async function refreshJob(jobId: string): Promise<RenderJob> {
  const snap = await adminDb.collection(JOBS_COLLECTION).doc(jobId).get();
  return snap.data() as RenderJob;
}

async function moveToNextStage(jobId: string, job: RenderJob, fromStage: RenderStage): Promise<void> {
  const index = STAGE_ORDER.indexOf(fromStage);
  const next = STAGE_ORDER[Math.min(index + 1, STAGE_ORDER.length - 1)];
  const [from] = STAGE_PROGRESS[next];
  await adminDb.collection(JOBS_COLLECTION).doc(jobId).set(
    { stage: next, progress: from, updatedAt: nowIso() },
    { merge: true },
  );
  job.stage = next;
}

async function failJob(job: RenderJob, error: Error, origin: string): Promise<TickResult> {
  const message = error.message.slice(0, 800);
  // Reprise automatique : jusqu'à 3 tentatives par étape (crash transitoire).
  if (job.attempts < 3) {
    await adminDb.collection(JOBS_COLLECTION).doc(job.id).set(
      { status: "queued", errorMessage: message, updatedAt: nowIso() },
      { merge: true },
    );
    await publishVideoTick(origin, job.id, 15);
    await logSystem(job.projectId, `Rendu ${job.id.slice(0, 8)} : incident à l'étape ${job.stage} (tentative ${job.attempts + 1}/3) — relance automatique. ${message}`);
    return { jobId: job.id, status: "queued", stage: job.stage, done: false, continued: true, message };
  }
  // Échec définitif : libère la réservation, purge, notifie.
  await adminDb.collection(JOBS_COLLECTION).doc(job.id).set(
    { status: "failed", errorCode: "RENDER_FAILED", errorMessage: message, updatedAt: nowIso() },
    { merge: true },
  );
  if (job.billedMinor > 0) {
    await releaseRenderBudget(job.userId, job.id, job.billedMinor).catch(() => undefined);
    await adminDb.collection(JOBS_COLLECTION).doc(job.id).set({ billedMinor: 0 }, { merge: true });
  }
  await cleanupJobTmp(job.id);
  await setProjectStatus(job.userId, job.projectId, "failed").catch(() => undefined);
  await logSystem(job.projectId, `Rendu ${job.id.slice(0, 8)} ÉCHOUÉ à l'étape ${job.stage} : ${message} Réservation libérée.`);
  await createNotification({
    userId: job.userId,
    type: "info",
    title: "Rendu vidéo échoué",
    body: `Le rendu a échoué (${job.stage}). Aucun montant débité — reprise possible depuis le studio vidéo.`,
  }).catch(() => undefined);
  return { jobId: job.id, status: "failed", stage: job.stage, done: true, continued: false, message };
}

// ────────────────────────────────────────────────────────────────────────────
// Étapes
// ────────────────────────────────────────────────────────────────────────────

/** PLAN : construit le plan de rendu + génère/envoie le fichier ASS. */
async function stagePlan(job: RenderJob, io: EngineIo): Promise<void> {
  const project = await getOwnedProjectOrThrow(job.userId, job.projectId);
  if (!project.script) throw new Error("Scénario absent au moment du rendu.");
  const timeline = project.timeline ?? null;
  if (!timeline) throw new Error("Timeline absente — elle est construite depuis le scénario avant le rendu.");

  const images = await listAssets(job.userId, job.projectId, "image");
  const imageByScene = new Map(images.filter((a) => a.role?.startsWith("scene:")).map((a) => [a.sceneId!, a]));
  const narrations = await listAssets(job.userId, job.projectId, "audio_narration");
  const narrationByScene = new Map(narrations.filter((a) => a.sceneId).map((a) => [a.sceneId!, a]));
  const sfxAssets = await listAssets(job.userId, job.projectId, "audio_sfx");
  const sfxByName = new Map(sfxAssets.filter((a) => a.role?.startsWith("sfx:")).map((a) => [a.role!.slice(4) as SfxName, a]));
  const musicAssets = await listAssets(job.userId, job.projectId, "audio_music");

  // Garde-fou : éléments audio manquants synthétisés ici (SFX procéduraux,
  // lit musical) — le rendu n'échoue pas pour un SFX manquant.
  const neededSfx = [...new Set(project.script.scenes.flatMap((s) => s.soundEffects))];
  const missingSfx = neededSfx.filter((name) => !sfxByName.has(name));
  const musicBedExplicit = timeline.musicBed?.assetId ? await getAsset(job.userId, timeline.musicBed.assetId) : null;
  if (missingSfx.length > 0 || (!musicBedExplicit && musicAssets.length === 0)) {
    const ensured = await ensureAudioAssetsForProject({
      userId: job.userId,
      project,
      totalDurationSec: project.script.estimatedDurationSec,
      neededSfx: missingSfx,
    });
    for (const [name, asset] of ensured.sfxByName) sfxByName.set(name, asset);
    if (ensured.musicBed) musicAssets.push(ensured.musicBed);
  }
  const musicBedFinal = musicBedExplicit ?? musicAssets[0];

  const dims = renderDimensions(project);
  let assR2Key: string | undefined;
  if (timeline.captions.enabled) {
    const ass = buildAssForRender(project, timeline, dims.width, dims.height);
    if (ass) {
      const upload = await uploadVideoAsset({
        userId: job.userId,
        projectId: job.projectId,
        domain: "subtitles",
        body: Buffer.from(ass, "utf8"),
        contentType: "text/plain; charset=utf-8",
        fileName: `subtitles_${job.id.slice(0, 8)}.ass`,
      });
      assR2Key = upload.r2Key;
    }
  }

  const plan = buildRenderPlan({
    project,
    timeline,
    jobId: job.id,
    imageByScene,
    narrationByScene,
    sfxAssetByName: sfxByName,
    musicBedAsset: musicBedFinal,
    derivedTargets: job.exports.map((e) => e.target),
    assR2Key,
  });
  if (plan.segments.length === 0) throw new Error("Plan de rendu vide : aucune scène avec image.");
  await adminDb.collection(JOBS_COLLECTION).doc(job.id).set({ plan, updatedAt: nowIso() }, { merge: true });
  job.plan = plan;
  await io.log(`Plan de rendu établi : ${plan.segments.length} segments, ${plan.estimatedSec} s attendues.`);
}

/** DOWNLOAD : préflight — vérifie que TOUTES les entrées sont résolubles. */
async function stageDownload(job: RenderJob, io: EngineIo): Promise<void> {
  const plan = job.plan;
  if (!plan) throw new Error("Plan absent.");
  const ids = new Set<string>();
  for (const item of plan.audioMix.narration) ids.add(item.assetId);
  for (const item of plan.audioMix.sfx) ids.add(item.assetId);
  for (const item of plan.audioMix.music) ids.add(item.assetId);
  for (const id of ids) {
    const asset = await io.getAsset(id);
    if (!asset) throw new Error(`Asset manquant avant rendu : ${id}`);
  }
  // Fichier ASS matérialisé en local pour le brûlage final.
  if (plan.subtitles?.assR2Key) {
    await io.materializeByName(plan.subtitles.assR2Key, "subtitles.ass");
  }
  await io.log(`Préflight OK (${ids.size} entrées audio vérifiées).`);
}

/** SEGMENTS : rend jusqu'à MAX_SEGMENTS_PER_TICK segments, checkpoint chacun. */
async function stageSegments(job: RenderJob, io: EngineIo, origin: string): Promise<TickResult> {
  const plan = job.plan!;
  const completed = new Set(job.checkpoints.completedSegments);
  const pending = plan.segments.filter((s) => !completed.has(s.index));
  if (pending.length === 0) {
    await moveToNextStage(job.id, job, "segments");
    const enqueued = await publishVideoTick(origin, job.id);
    return { jobId: job.id, status: "processing", stage: job.stage, done: false, continued: enqueued, message: "Tous les segments déjà rendus." };
  }
  const batch = pending.slice(0, MAX_SEGMENTS_PER_TICK);
  const batchIndexes = new Set(batch.map((s) => s.index));
  const filteredPlan: RenderPlan = { ...plan, segments: plan.segments.filter((s) => batchIndexes.has(s.index)) };

  await renderSegments({
    plan: filteredPlan,
    io,
    userId: job.userId,
    completedSegments: [...completed],
    onSegmentDone: async (index) => {
      completed.add(index);
      const progressBase = STAGE_PROGRESS.segments[0];
      const span = STAGE_PROGRESS.segments[1] - progressBase;
      const ratio = completed.size / Math.max(1, plan.segments.length);
      await adminDb.collection(JOBS_COLLECTION).doc(job.id).set(
        {
          "checkpoints.completedSegments": [...completed],
          progress: Math.round((progressBase + span * ratio) * 100) / 10000 * 100,
          updatedAt: nowIso(),
        },
        { merge: true },
      );
    },
  });

  const remaining = plan.segments.length - completed.size;
  if (remaining > 0) {
    const enqueued = await publishVideoTick(origin, job.id);
    return { jobId: job.id, status: "processing", stage: "segments", done: false, continued: enqueued, message: `${remaining} segment(s) restant(s).` };
  }
  await moveToNextStage(job.id, job, "segments");
  const enqueued = await publishVideoTick(origin, job.id);
  return { jobId: job.id, status: "processing", stage: job.stage, done: false, continued: enqueued, message: "Segments terminés." };
}

/** TRANSITIONS : xfade chaîne sur les segments. */
/** Seuil au-delà duquel l'assemblage récursif (Long Video Engine) s'applique. */
const RECURSIVE_ASSEMBLY_THRESHOLD = 12;

async function stageTransitions(job: RenderJob, io: EngineIo): Promise<void> {
  if (job.checkpoints.transitionsDone) return;
  const plan = job.plan!;
  const segmentFiles = plan.segments.map((s) => `${io.tmpDir}/segment_${String(s.index).padStart(4, "0")}.mp4`);

  let assembledFile: string;
  let expectedSec: number;
  if (plan.segments.length > RECURSIVE_ASSEMBLY_THRESHOLD) {
    // Long Video Engine : passes récursives bornées, checkpoint par passe.
    const result = await assembleRecursive({
      plan,
      io,
      segmentFiles,
      startPass: job.checkpoints.transitionPass,
      onPassDone: async (pass) => {
        await adminDb.collection(JOBS_COLLECTION).doc(job.id).set(
          { "checkpoints.transitionPass": pass, updatedAt: nowIso() },
          { merge: true },
        );
      },
    });
    assembledFile = result.file;
    expectedSec = result.expectedDurationSec;
    if (assembledFile !== `${io.tmpDir}/video_noaudio.mp4`) {
      // Normalisation du nom attendu par les étapes suivantes.
      const { rename } = await import("node:fs/promises");
      await rename(assembledFile, `${io.tmpDir}/video_noaudio.mp4`);
    }
  } else {
    const assembled = await assembleTransitions({ plan, io, segmentFiles });
    assembledFile = assembled.file;
    expectedSec = assembled.durationSec;
    if (assembledFile !== `${io.tmpDir}/video_noaudio.mp4`) {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(assembledFile, `${io.tmpDir}/video_noaudio.mp4`);
    }
  }
  await adminDb.collection(JOBS_COLLECTION).doc(job.id).set(
    { "checkpoints.transitionsDone": true, updatedAt: nowIso() },
    { merge: true },
  );
  await io.log(`Assemblage vidéo terminé (${Math.round(expectedSec)} s attendues).`);
}

/** AUDIO : mixage narration + musique duckée + SFX. */
async function stageAudio(job: RenderJob, io: EngineIo): Promise<void> {
  if (job.checkpoints.audioDone) return;
  const plan = job.plan!;
  const expected = plan.estimatedSec;
  const audioFile = await mixAudio({ plan, io, durationSec: expected });
  if (!audioFile) {
    await io.log("Aucune entrée audio prévue — vidéo muette assumée (narration/musique absentes).");
  }
  await adminDb.collection(JOBS_COLLECTION).doc(job.id).set({ "checkpoints.audioDone": true, updatedAt: nowIso() }, { merge: true });
}

/** SUBTITLES : le fichier ASS est prêt (brûlé au finalize) — checkpoint. */
async function stageSubtitles(job: RenderJob): Promise<void> {
  await adminDb.collection(JOBS_COLLECTION).doc(job.id).set({ "checkpoints.subtitlesDone": true, updatedAt: nowIso() }, { merge: true });
}

/** QC : analyse réelle du master intermédiaire, boucle de correction. */
async function stageQc(job: RenderJob, io: EngineIo, origin: string): Promise<TickResult> {
  const plan = job.plan!;
  // Le master préliminaire : vidéo (transitions) + audio muxés sans ASS.
  const masterTmp = join2(io.tmpDir, "master.mp4");
  const videoFile = join2(io.tmpDir, "video_noaudio.mp4");
  const audioFile = job.checkpoints.audioDone ? join2(io.tmpDir, "audio_final.m4a") : null;
  await finalizeMaster({
    plan,
    io,
    videoNoAudioFile: videoFile,
    audioFile,
    durationSec: plan.estimatedSec,
    burnAssFileName: plan.subtitles?.assR2Key ? "subtitles.ass" : undefined,
  });
  const report = await analyzeRenderedMaster({
    masterFile: masterTmp,
    tmpDir: io.tmpDir,
    plan,
    expectedDurationSec: plan.estimatedSec,
    subtitlesEnabled: Boolean(plan.subtitles?.assR2Key),
  });
  await adminDb.collection(JOBS_COLLECTION).doc(job.id).set(
    { qcReport: report, "checkpoints.qcDone": true, updatedAt: nowIso() },
    { merge: true },
  );
  await io.log(`QC : ${report.passed ? "OK" : `${report.issues.length} problème(s)`}.`);

  const decision = decideAutoFix(report, plan);
  if (decision.action === "fix" && job.autoFixRounds < MAX_AUTO_FIX_ROUNDS) {
    const completed = new Set(job.checkpoints.completedSegments);
    for (const index of decision.reRenderSegments) completed.delete(index);
    await adminDb.collection(JOBS_COLLECTION).doc(job.id).set(
      {
        autoFixRounds: FieldValue.increment(1),
        "checkpoints.completedSegments": [...completed],
        "checkpoints.audioDone": job.checkpoints.audioDone && !decision.rebuildAudio,
        "checkpoints.qcDone": false,
        stage: "segments",
        updatedAt: nowIso(),
      },
      { merge: true },
    );
    await io.log(`QC : correction automatique ronde ${job.autoFixRounds + 1}/${MAX_AUTO_FIX_ROUNDS} (${decision.reRenderSegments.length} segment(s), audio ${decision.rebuildAudio ? "oui" : "non"}).`);
    const enqueued = await publishVideoTick(origin, job.id);
    return { jobId: job.id, status: "processing", stage: "segments", done: false, continued: enqueued, message: "Boucle de correction relancée." };
  }
  await moveToNextStage(job.id, job, "qc");
  const enqueued = await publishVideoTick(origin, job.id);
  return { jobId: job.id, status: "processing", stage: job.stage, done: false, continued: enqueued, message: "QC validé." };
}

/** EXPORTS : formats dérivés (9:16 avec sous-titres Shorts, 1:1…). */
async function stageExports(job: RenderJob, io: EngineIo, origin: string): Promise<TickResult> {
  const plan = job.plan!;
  // Master présent dans le tmp ? Sinon (job d'export seul), matérialisation depuis R2.
  const { access } = await import("node:fs/promises");
  try {
    await access(`${io.tmpDir}/master.mp4`);
  } catch {
    if (!plan.masterR2Key) throw new Error("Master absent du tmp et aucune clé R2 de référence.");
    await io.materializeByName(plan.masterR2Key, "master.mp4");
    await io.log("Master téléchargé depuis le stockage pour les exports.");
  }
  const pending = job.exports.filter((e) => e.status === "pending");
  for (const target of pending) {
    const isVertical = target.target.endsWith("9_16");
    let assFileName: string | undefined;
    if (plan.subtitles?.assR2Key) {
      assFileName = "subtitles.ass";
      if (isVertical) {
        const project = await getOwnedProjectOrThrow(job.userId, job.projectId);
        const shortsAss = buildShortsAss(project, 1080, 1920);
        if (shortsAss) await io.writeTmp("subtitles_shorts.ass", shortsAss);
        assFileName = shortsAss ? "subtitles_shorts.ass" : "subtitles.ass";
      }
    }
    const outFile = await renderExportFormat({
      io,
      masterFile: join2(io.tmpDir, "master.mp4"),
      target: target.target,
      assFileName,
    });
    const { readFile, stat } = await import("node:fs/promises");
    const body = await readFile(outFile);
    const sizeBytes = (await stat(outFile)).size;
    const r2Key = await io.uploadRender(`renders/${job.id}/export_${target.target}.mp4`, body, "renders");
    const index = job.exports.findIndex((e) => e.target === target.target);
    job.exports[index] = { ...target, r2Key, sizeBytes, status: "done" };
    await adminDb.collection(JOBS_COLLECTION).doc(job.id).set(
      { exports: job.exports, updatedAt: nowIso() },
      { merge: true },
    );
    await io.log(`Export ${target.target} livré (${Math.round(sizeBytes / 1024 / 1024)} Mo).`);
  }
  const remaining = job.exports.filter((e) => e.status === "pending").length;
  if (remaining > 0) {
    const enqueued = await publishVideoTick(origin, job.id);
    return { jobId: job.id, status: "processing", stage: "exports", done: false, continued: enqueued, message: `${remaining} export(s) restant(s).` };
  }
  await moveToNextStage(job.id, job, "exports");
  const enqueued = await publishVideoTick(origin, job.id);
  return { jobId: job.id, status: "processing", stage: job.stage, done: false, continued: enqueued, message: "Exports terminés." };
}

/** FINALIZE : upload master, règlement wallet, projet terminé, purge, notification. */
async function stageFinalize(job: RenderJob, io: EngineIo, _origin: string): Promise<TickResult> {
  const plan = job.plan!;
  // Job d'export seul : pas de re-upload ni de re-facturation du master.
  if (job.mode === "exports_only") {
    const doneCount = job.exports.filter((e) => e.status === "done").length;
    if (job.billedMinor > 0) {
      await settleExportsBudget({ userId: job.userId, jobId: job.id, reservedMinor: job.billedMinor, targets: doneCount });
    }
    await adminDb.collection(JOBS_COLLECTION).doc(job.id).set(
      { status: "completed", stage: "finalize", progress: 1, updatedAt: nowIso() },
      { merge: true },
    );
    await cleanupJobTmp(job.id);
    await logSystem(job.projectId, `Exports additionnels livrés (${doneCount}).`);
    await createNotification({
      userId: job.userId,
      type: "info",
      title: "Formats de diffusion prêts",
      body: `${doneCount} format(s) dérivé(s) (Shorts/TikTok/Reels/carré) disponibles dans le studio vidéo.`,
    }).catch(() => undefined);
    return { jobId: job.id, status: "completed", stage: "finalize", done: true, continued: false, message: "Exports livrés." };
  }
  const uploaded = await uploadMaster({
    io,
    masterFile: join2(io.tmpDir, "master.mp4"),
    projectId: job.projectId,
    jobId: job.id,
  });
  const actualMinor = await settleRenderBudget({
    userId: job.userId,
    jobId: job.id,
    estimate: estimateRenderCost({ durationSec: plan.estimatedSec, resolution: plan.resolution }),
    actualDurationSec: uploaded.durationSec,
  });
  await adminDb.collection(JOBS_COLLECTION).doc(job.id).set(
    {
      status: "completed",
      stage: "finalize",
      progress: 1,
      "plan.masterR2Key": uploaded.r2Key,
      output: { r2Key: uploaded.r2Key, sizeBytes: uploaded.sizeBytes, durationSec: uploaded.durationSec, width: uploaded.width, height: uploaded.height },
      billedMinor: actualMinor,
      updatedAt: nowIso(),
    },
    { merge: true },
  );
  await setProjectStatus(job.userId, job.projectId, "completed");
  await adminDb.collection("videoProjects").doc(job.projectId).set(
    { stats: { renderedSeconds: uploaded.durationSec, billedMinor: FieldValue.increment(actualMinor) }, updatedAt: nowIso() },
    { merge: true },
  );
  await cleanupJobTmp(job.id);
  await logSystem(job.projectId, `Rendu ${job.id.slice(0, 8)} TERMINÉ : ${uploaded.durationSec.toFixed(1)} s, ${Math.round(uploaded.sizeBytes / 1024 / 1024)} Mo, ${job.exports.filter((e) => e.status === "done").length} export(s). Facturé ${actualMinor} minor.`);
  await createNotification({
    userId: job.userId,
    type: "info",
    title: "Vidéo prête",
    body: `Votre rendu (${uploaded.durationSec.toFixed(0)} s, ${plan.resolution}) est disponible dans le studio vidéo, avec ses exports de diffusion.`,
  }).catch(() => undefined);
  return { jobId: job.id, status: "completed", stage: "finalize", done: true, continued: false, message: "Rendu livré." };
}

function join2(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

// ────────────────────────────────────────────────────────────────────────────
// Engine IO — implémentation concrète (R2 réel, cloisonnement propriétaire)
// ────────────────────────────────────────────────────────────────────────────

function buildEngineIo(job: RenderJob, tmpDir: string): EngineIo {
  return {
    tmpDir,
    getAsset: (assetId) => getAsset(job.userId, assetId),
    materialize: async (asset: VideoAsset, fileName) =>
      materializeForRender({ userId: job.userId, r2Key: asset.r2Key, tmpDir, fileName, maxBytes: 512 * 1024 * 1024 }),
    materializeByName: (r2Key, fileName) =>
      materializeForRender({ userId: job.userId, r2Key, tmpDir, fileName, maxBytes: 512 * 1024 * 1024 }),
    writeTmp: async (fileName, content) => {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const target = join(tmpDir, fileName);
      await writeFile(target, content, "utf8");
      return target;
    },
    uploadRender: async (fileName, body) => {
      const upload = await uploadVideoAsset({
        userId: job.userId,
        projectId: job.projectId,
        domain: "renders",
        body,
        contentType: "video/mp4",
        fileName: fileName.split("/").pop(),
      });
      return upload.r2Key;
    },
    log: (message) => logSystem(job.projectId, message),
  };
}

/** Récupère un job pour lecture (worker sans user : vérification interne). */
export async function getJob(jobId: string): Promise<RenderJob | null> {
  const snap = await adminDb.collection(JOBS_COLLECTION).doc(jobId).get();
  return snap.exists ? (snap.data() as RenderJob) : null;
}

/**
 * Tick autonome : prend le prochain job en file et le fait avancer
 * (utilisé par le worker standalone scripts/video-worker.mjs).
 */
export async function claimNextQueuedJob(): Promise<RenderJob | null> {
  const snap = await adminDb.collection(JOBS_COLLECTION).where("status", "==", "queued").get();
  const jobs = snap.docs.map((d) => d.data() as RenderJob).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  for (const job of jobs) {
    const claimed = await adminDb.collection(JOBS_COLLECTION).doc(job.id).set(
      { status: "processing", updatedAt: nowIso() },
      { merge: true },
    ).then(() => true).catch(() => false);
    if (claimed) return job;
  }
  return null;
}
