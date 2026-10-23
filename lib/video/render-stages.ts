import "server-only";

/**
 * GEN3IA VIDEO AGENT — ÉTAPES DE RENDU (module 19, partie 2, extrait de
 * render-queue.ts).
 *
 * Les 9 étapes idempotentes du rendu (plan, download, segments, transitions,
 * audio, subtitles, qc, exports, finalize) + l'implémentation EngineIo
 * (R2 réel, cloisonnement propriétaire) + la restauration cross-instance
 * depuis R2 (Task 127). Un tick avance d'une étape (ou d'un lot de
 * segments) ; chaque étape vérifie ses checkpoints — jamais de re-rendu
 * complet. Code déplacé tel quel — aucun changement de comportement.
 */

import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "@/lib/r2fs";
import type {
  RenderJob,
  RenderStage,
  VideoAsset,
  VideoProject,
  SfxName,
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
  type EngineIo,
} from "@/lib/video/render/engine";
import { materializeForRender, uploadVideoAsset } from "@/lib/video/storage";
import { analyzeRenderedMaster, decideAutoFix, hasUserContractViolation } from "@/lib/video/qc-service";
// Task 120 — QC ALLÉGÉE : sonde ffprobe du master (cache job, une seule par rendu).
import { probeMedia } from "@/lib/video/ffmpeg";
import { estimateRenderCost, settleRenderBudget, settleExportsBudget } from "@/lib/video/credits";
import { assembleRecursive } from "@/lib/video/long-video-service";
import { VIDEO_LIMITS, MAX_AUTO_FIX_ROUNDS } from "@/lib/video/security";
import { analyzeNarrationAmplitude, alignSceneBoundariesToSilences, type VoiceTimeline } from "@/lib/video/voice-sync";
import { runSubAgentWave, shouldDeploySubAgents } from "@/lib/video/sub-agents";
import { createNotification } from "@/lib/notifications/repository";
import { ensureAudioAssetsForProject } from "@/lib/video/audio-engine";
import { ensureProjectTimeline } from "@/lib/video/timeline-bootstrap";
import { writeCheckpointSet } from "@/lib/db/firestore-resilient";
import { computeJobProgress, cleanupJobTmp, moveToNextStage, JOBS_COLLECTION } from "@/lib/video/render-job";
import { nowIso } from "@/lib/video/queue-core";
// Import TYPE-SEUL (effacé à la compilation — aucun cycle runtime) : le
// contrat TickResult reste publié par l'orchestrateur render-queue.ts.
import type { TickResult } from "@/lib/video/render-queue";

/**
 * Résultat d'exécution d'une étape : le publishing du tick suivant et la
 * libération du bail restent sous le contrôle de advanceJob — ordre garanti
 * « bail libéré AVANT re-file » (sinon le tick suivant arriverait sur un
 * bail encore actif et serait no-op jusqu'à son expiration).
 */
export type StageOutcome =
  | { kind: "next" }
  | { kind: "continue"; stage: RenderStage; message: string; delaySeconds?: number }
  | { kind: "terminal"; result: TickResult };

/** Segments rendus par tick (Task 120 : parallèles × maxParallelSegmentRenders). */
const MAX_SEGMENTS_PER_TICK = 4;

// ────────────────────────────────────────────────────────────────────────────
// Étapes
// ────────────────────────────────────────────────────────────────────────────

/** PLAN : construit le plan de rendu + génère/envoie le fichier ASS. */
async function stagePlan(job: RenderJob, io: EngineIo): Promise<void> {
  // Timeline matérialisée ICI (Task 1-a FIX 2) : la lazy-init partagée avec
  // la route GET (timeline-bootstrap) construit la timeline depuis le
  // scénario si l'utilisateur n'a jamais ouvert le panneau — idempotent.
  const { project, timeline } = await ensureProjectTimeline(job.userId, job.projectId);
  if (!project.script) throw new Error("Scénario absent au moment du rendu.");

  const images = await listAssets(job.userId, job.projectId, "image");
  const imageByScene = new Map(images.filter((a) => a.role?.startsWith("scene:")).map((a) => [a.sceneId!, a]));
  // Task 154 — clips vidéo IA par scène (Agnes Video) : consommés par le
  // planner en PRIORITÉ (mouvement réel), l'image reste le repli.
  const sceneVideos = await listAssets(job.userId, job.projectId, "video");
  const videoByScene = new Map(sceneVideos.filter((a) => a.role?.startsWith("scene-video:")).map((a) => [a.sceneId!, a]));
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
  const needsAudioBackfill = missingSfx.length > 0 || (!musicBedExplicit && musicAssets.length === 0);

  // Task 134 — SOUS-AGENTS : le backfill audio (SFX procéduraux + lit
  // musical) et l'analyse voice-sync des narrations sont INDÉPENDANTS
  // (fichiers tmp distincts, aucun shared state) — ils s'exécutent
  // désormais EN PARALLÈLE au lieu d'enchaîner deux phases séquentielles.
  const [audioBackfill, voiceSyncByScene] = await Promise.all([
    needsAudioBackfill
      ? ensureAudioAssetsForProject({
          userId: job.userId,
          project,
          totalDurationSec: project.script.estimatedDurationSec,
          neededSfx: missingSfx,
        }).catch(() => null)
      : Promise.resolve(null),
    buildVoiceSyncTimelines(job, io, narrationByScene, project.script.scenes),
  ]);
  if (audioBackfill) {
    for (const [name, asset] of audioBackfill.sfxByName) sfxByName.set(name, asset);
    if (audioBackfill.musicBed) musicAssets.push(audioBackfill.musicBed);
  }
  const musicBedFinal = musicBedExplicit ?? musicAssets[0];

  // Task 119 — COUPES ALIGNÉES : le projet de travail reçoit les frontières
  // ajustées sur les silences/fin de phrase (UNE source de vérité pour
  // segments + mixage audio + sous-titres ; durée totale inchangée).
  const planProject = applyAlignedScenes(project, voiceSyncByScene);

  const dims = renderDimensions(project);
  let assR2Key: string | undefined;
  if (timeline.captions.enabled) {
    const ass = buildAssForRender(planProject, timeline, dims.width, dims.height);
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
    project: planProject,
    timeline,
    jobId: job.id,
    imageByScene,
    narrationByScene,
    sfxAssetByName: sfxByName,
    musicBedAsset: musicBedFinal,
    derivedTargets: job.exports.map((e) => e.target),
    assR2Key,
    ...(videoByScene.size > 0 ? { videoByScene } : {}),
    ...(voiceSyncByScene.size > 0 ? { voiceSyncByScene } : {}),
  });
  if (plan.segments.length === 0) throw new Error("Plan de rendu vide : aucune scène avec image.");
  // Task 95-c — écriture via la couche résiliente (checkpoint).
  await writeCheckpointSet(JOBS_COLLECTION, job.id, { plan, updatedAt: nowIso() }, job.userId);
  job.plan = plan;
  await io.log(`Plan de rendu établi : ${plan.segments.length} segments, ${plan.estimatedSec} s attendues${videoByScene.size > 0 ? `, ${videoByScene.size} clip(s) vidéo IA (${[...videoByScene.values()].length} scène(s) en mouvement réel)` : ""}${voiceSyncByScene.size > 0 ? `, ${voiceSyncByScene.size} narration(s) synchronisée(s) à la voix (pouls/coupes)` : ""}.`);
}

/**
 * Task 119 — analyse l'énergie vocale des narrations du plan (voice-sync).
 * Chaque narration est matérialisée puis analysée (astats RMS par fenêtres) :
 * timeline d'amplitude → effets audio-réactifs + alignement des coupes.
 * JAMAIS BLOQUANT : une analyse en échec est ignorée (rendu sans synchro
 * plutôt que pas de rendu).
 *
 * Task 134 — SOUS-AGENTS PARALLÈLES : l'analyse historique était
 * SÉQUENTIELLE (jusqu'à maxVoiceSyncScenes = 150 analyses ffprobe/astats
 * l'une après l'autre — goulot majeur du stagePlan). Chaque scène est
 * désormais confiée à un sous-agent de synchro voix, exécutés en vague
 * bornée par VIDEO_LIMITS.maxParallelVoiceSyncAnalyzes. Aucune écriture
 * Firestore par sous-agent : la map est consolidée en mémoire (contrat
 * inchangé pour l'appelant).
 */
async function buildVoiceSyncTimelines(
  job: RenderJob,
  io: EngineIo,
  narrationByScene: Map<string, VideoAsset>,
  scenes: ReadonlyArray<{ id: string; durationSec: number }>,
): Promise<Map<string, VoiceTimeline>> {
  void job;
  const timelines = new Map<string, VoiceTimeline>();
  const candidates = scenes
    .filter((scene) => narrationByScene.has(scene.id))
    .slice(0, Math.max(1, VIDEO_LIMITS.maxVoiceSyncScenes));
  if (candidates.length === 0) return timelines;

  const analyzeOne = async (scene: { id: string; durationSec: number }): Promise<void> => {
    const asset = narrationByScene.get(scene.id)!;
    const ext = asset.r2Key.includes(".") ? asset.r2Key.split(".").pop()! : "mp3";
    const audioFile = await io.materialize(asset, `vsync_${scene.id}.${ext}`);
    const timeline = await analyzeNarrationAmplitude({
      audioFile,
      cwd: io.tmpDir,
      durationSec: asset.media?.durationSec ?? scene.durationSec,
    });
    if (timeline && timeline.windows.length > 0) timelines.set(scene.id, timeline);
  };

  if (shouldDeploySubAgents(candidates.length)) {
    await runSubAgentWave("voice_sync", candidates, VIDEO_LIMITS.maxParallelVoiceSyncAnalyzes, analyzeOne, {
      log: (message) => io.log(message),
    });
  } else {
    // Petit lot : exécution directe inchangée (zéro overhead de vague).
    for (const scene of candidates) {
      try {
        await analyzeOne(scene);
      } catch {
        // Analyse impossible pour CETTE scène : ignorée (jamais bloquant).
      }
    }
  }
  return timelines;
}

/**
 * Task 119 — applique l'alignement des frontières aux scènes du projet de
 * travail (copie — le projet PERSISTÉ n'est pas touché : l'alignement est un
 * paramètre de RENDU, l'atelier garde les durées éditées par l'utilisateur).
 */
function applyAlignedScenes(project: VideoProject, voiceSyncByScene: Map<string, VoiceTimeline>): VideoProject {
  if (voiceSyncByScene.size === 0 || !project.script) return project;
  const aligned = new Map(alignSceneBoundariesToSilences(project.script.scenes, voiceSyncByScene).map((a) => [a.id, a]));
  if (aligned.size === 0) return project;
  const scenes = project.script.scenes.map((scene) => {
    const adjusted = aligned.get(scene.id);
    return adjusted ? { ...scene, durationSec: adjusted.durationSec, startSec: adjusted.startSec } : scene;
  });
  return { ...project, script: { ...project.script, scenes } };
}

/** DOWNLOAD : préflight — vérifie que TOUTES les entrées sont résolubles.
 * Task 134 — SOUS-AGENTS : les vérifications getAsset (une lecture par
 * entrée audio) sont exécutées en vague parallèle bornée. */
async function stageDownload(job: RenderJob, io: EngineIo): Promise<void> {
  const plan = job.plan;
  if (!plan) throw new Error("Plan absent.");
  const ids = new Set<string>();
  for (const item of plan.audioMix.narration) ids.add(item.assetId);
  for (const item of plan.audioMix.sfx) ids.add(item.assetId);
  for (const item of plan.audioMix.music) ids.add(item.assetId);
  const idList = [...ids];
  const checkOne = async (id: string): Promise<void> => {
    const asset = await io.getAsset(id);
    if (!asset) throw new Error(`Asset manquant avant rendu : ${id}`);
  };
  if (shouldDeploySubAgents(idList.length)) {
    const wave = await runSubAgentWave("audio_preflight", idList, VIDEO_LIMITS.maxParallelPreflightChecks, checkOne);
    // Une entrée manquante reste FATALE (contrat historique conservé).
    const firstMissing = wave.outcomes.find((o) => o.status === "rejected");
    if (firstMissing) throw firstMissing.reason;
  } else {
    for (const id of idList) {
      await checkOne(id);
    }
  }
  // Fichier ASS matérialisé en local pour le brûlage final.
  if (plan.subtitles?.assR2Key) {
    await io.materializeByName(plan.subtitles.assR2Key, "subtitles.ass");
  }
  await io.log(`Préflight OK (${idList.length} entrées audio vérifiées).`);
}

/**
 * SEGMENTS (Task 120 — PARALLÈLES) : rend jusqu'à MAX_SEGMENTS_PER_TICK
 * segments en ≤ VIDEO_LIMITS.maxParallelSegmentRenders processus FFmpeg
 * simultanés (mémoire bornée serverless), checkpoint UNIQUE consolidé après
 * la vague (limite Firestore ~1 écriture/s/doc), budget temps du tick honoré
 * AVANT chaque démarrage de segment (le pool marque « non démarré » → le
 * prochain tick les prend, checkpoint maître).
 */
async function stageSegments(job: RenderJob, io: EngineIo, timeBudgetMs?: number): Promise<StageOutcome> {
  const plan = job.plan!;
  const completed = new Set(job.checkpoints.completedSegments);
  const pending = plan.segments.filter((s) => !completed.has(s.index));
  if (pending.length === 0) {
    await moveToNextStage(job.id, job, "segments");
    return { kind: "continue", stage: job.stage, message: "Tous les segments déjà rendus." };
  }
  const batch = pending.slice(0, MAX_SEGMENTS_PER_TICK);
  const deadlineMs = typeof timeBudgetMs === "number" && timeBudgetMs > 0 ? Date.now() + timeBudgetMs : null;
  const completedAtTickStart = completed.size;

  await renderSegments({
    plan: { ...plan, segments: batch },
    io,
    userId: job.userId,
    completedSegments: [...completed],
    concurrency: Math.max(1, VIDEO_LIMITS.maxParallelSegmentRenders),
    deadlineMs,
    // Task 106-fix — checkpoint en MÉMOIRE seulement (limite Firestore
    // ~1 écriture/s/doc) : UN SEUL checkpoint consolidé APRÈS la vague.
    onSegmentDone: async (index) => {
      completed.add(index);
    },
  });

  // Task 106-fix — UN checkpoint par tick (consultation immédiate par le
  // claim suivant ; les segments réellement rendus sont conservés en local
  // tmp, le pire cas est un re-rendu des derniers segments du tick).
  // Task 127 — PERSISTANCE R2 : chaque segment rendu est AUSSI téléversé
  // dans R2 (renders/<jobId>/segments/…) — une instance relais le
  // re-téléchargera au lieu de le re-rendre (fin des boucles de re-rendu
  // observées en production : un tick par instance ≠ le /tmp du précédent).
  const segmentsR2: Record<string, string> = { ...(job.checkpoints.segmentsR2 ?? {}) };
  let uploadedSegments = 0;
  for (const index of completed) {
    if (segmentsR2[String(index)]) continue;
    const file = `${io.tmpDir}/${segmentFileName(index)}`;
    if (!(await pathExists(file))) continue;
    const { readFile: readSegment } = await import("node:fs/promises");
    const body = await readSegment(file);
    segmentsR2[String(index)] = await io.uploadRender(
      `renders/${job.id}/segments/${segmentFileName(index)}`,
      body,
      "renders",
    );
    uploadedSegments += 1;
  }
  if (completed.size > completedAtTickStart || uploadedSegments > 0) {
    await writeCheckpointSet(
      JOBS_COLLECTION,
      job.id,
      {
        "checkpoints.completedSegments": [...completed],
        "checkpoints.segmentsR2": segmentsR2,
        progress: computeJobProgress("segments", completed.size, plan.segments.length),
        updatedAt: nowIso(),
      },
      job.userId,
    );
  }

  const remaining = plan.segments.length - completed.size;
  if (remaining > 0) {
    return { kind: "continue", stage: "segments", message: `${remaining} segment(s) restant(s).` };
  }
  await moveToNextStage(job.id, job, "segments");
  return { kind: "continue", stage: job.stage, message: "Segments terminés." };
}

/** TRANSITIONS : xfade chaîne sur les segments. */
/** Seuil au-delà duquel l'assemblage récursif (Long Video Engine) s'applique. */
const RECURSIVE_ASSEMBLY_THRESHOLD = 12;

async function stageTransitions(job: RenderJob, io: EngineIo): Promise<StageOutcome> {
  if (job.checkpoints.transitionsDone) {
    await moveToNextStage(job.id, job, "transitions");
    return { kind: "continue", stage: job.stage, message: "Transitions déjà assemblées." };
  }
  const plan = job.plan!;
  const segmentFiles = plan.segments.map((s) => `${io.tmpDir}/${segmentFileName(s.index)}`);
  // Garde cross-instance : un seul fichier de segment manquant ferait échouer
  // ffmpeg en code 1 — Task 127 : restauration R2 du segment AVANT tout
  // re-rendu (les segments rendus sont persistés dès leur production) ; le
  // rollback déterministe ne reste que si la clé R2 est absente/cassée.
  for (let i = 0; i < segmentFiles.length; i += 1) {
    const file = segmentFiles[i];
    if (await pathExists(file)) continue;
    const index = plan.segments[i].index;
    const key = job.checkpoints.segmentsR2?.[String(index)];
    if (key) {
      try {
        await io.materializeByName(key, segmentFileName(index));
        continue;
      } catch {
        // Clé R2 cassée/introuvable : re-rendu déterministe ci-dessous.
      }
    }
    await resetToSegments(job.id, job, "segments absents sur cette instance (transitions)");
    return { kind: "continue", stage: "segments", message: "Reprise : segments re-rendus sur cette instance." };
  }

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
        // Task 95-c — checkpoint de passe via la couche résiliente.
        await writeCheckpointSet(
          JOBS_COLLECTION,
          job.id,
          { "checkpoints.transitionPass": pass, updatedAt: nowIso() },
          job.userId,
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
  // Task 127 — PERSISTANCE R2 du montage : video_noaudio.mp4 est téléversé
  // dès sa production — la QC sur une instance relais le re-télécharge au
  // lieu de re-rendre tous les segments.
  const { readFile: readAssembly } = await import("node:fs/promises");
  const assemblyBody = await readAssembly(`${io.tmpDir}/video_noaudio.mp4`);
  const videoNoaudioR2 = await io.uploadRender(`renders/${job.id}/video_noaudio.mp4`, assemblyBody, "renders");
  await writeCheckpointSet(
    JOBS_COLLECTION,
    job.id,
    { "checkpoints.transitionsDone": true, "checkpoints.videoNoaudioR2": videoNoaudioR2, updatedAt: nowIso() },
    job.userId,
  );
  await io.log(`Assemblage vidéo terminé (${Math.round(expectedSec)} s attendues).`);
  await moveToNextStage(job.id, job, "transitions");
  return { kind: "continue", stage: job.stage, message: "Transitions terminées." };
}

/** AUDIO : mixage narration + musique duckée + SFX. */
async function stageAudio(job: RenderJob, io: EngineIo): Promise<void> {
  if (job.checkpoints.audioDone) return;
  const plan = job.plan!;
  const expected = plan.estimatedSec;
  const audioFile = await mixAudio({ plan, io, durationSec: expected });
  if (!audioFile) {
    // Honnêteté d'état : si le plan PRÉVOIT de l'audio (narration/musique/SFX),
    // un mixage null signifie que les assets n'ont pas pu être résolus — on
    // échoue le tick (relance au checkpoint) au lieu de poser un checkpoint
    // « audio fait » qui produirait un master muet et une boucle QC inutile.
    const audioExpected =
      plan.audioMix.narration.length > 0 ||
      plan.audioMix.music.length > 0 ||
      plan.audioMix.sfx.length > 0;
    if (audioExpected) {
      throw new Error(
        "Mixage audio attendu par le plan mais aucun fichier produit (assets musique/SFX indisponibles).",
      );
    }
    await io.log("Aucune entrée audio prévue — vidéo muette assumée (narration/musique absentes).");
  }
  await writeCheckpointSet(JOBS_COLLECTION, job.id, { "checkpoints.audioDone": true, updatedAt: nowIso() }, job.userId);
}

/** SUBTITLES : le fichier ASS est prêt (brûlé au finalize) — checkpoint. */
async function stageSubtitles(job: RenderJob): Promise<void> {
  await writeCheckpointSet(JOBS_COLLECTION, job.id, { "checkpoints.subtitlesDone": true, updatedAt: nowIso() }, job.userId);
}

/** QC : analyse réelle du master intermédiaire, boucle de correction. */
async function stageQc(job: RenderJob, io: EngineIo): Promise<StageOutcome> {
  const plan = job.plan!;
  // Le master préliminaire : vidéo (transitions) + audio muxés sans ASS.
  const masterTmp = join2(io.tmpDir, "master.mp4");
  const videoFile = join2(io.tmpDir, "video_noaudio.mp4");
  // Garde cross-instance : chaque tick peut atterrir sur une instance lambda
  // différente. Task 127 — RESTAURATION R2 : le montage PERSISTÉ
  // (videoNoaudioR2) est re-téléchargé ; le rollback déterministe ne reste
  // que si la clé R2 est absente/cassée.
  if (!(await pathExists(videoFile))) {
    const assemblyKey = job.checkpoints.videoNoaudioR2;
    let restored = false;
    if (assemblyKey) {
      try {
        await io.materializeByName(assemblyKey, "video_noaudio.mp4");
        restored = true;
        await io.log("QC : montage restauré depuis R2 (instance relais) — pas de re-rendu.");
      } catch {
        restored = false;
      }
    }
    if (!restored) {
      await resetToSegments(job.id, job, "montage vidéo (video_noaudio) absent sur cette instance (QC)");
      return { kind: "continue", stage: "segments", message: "Reprise : montage vidéo absent, rendu relancé." };
    }
  }
  const audioPath = join2(io.tmpDir, "audio_final.m4a");
  let audioFile: string | null = (await pathExists(audioPath)) ? audioPath : null;
  if (!audioFile && job.checkpoints.audioDone) {
    // L'audio a été mixé sur une autre instance : re-mixage DÉTERMINISTE ici
    // (assets musique/SFX re-téléchargés depuis R2) au lieu d'un mux muet
    // qui relancerait la boucle auto-fix sans jamais aboutir.
    await io.log("QC : fichier audio absent sur cette instance — re-mixage déterministe depuis les assets.");
    audioFile = await mixAudio({ plan, io, durationSec: plan.estimatedSec });
  }
  if (plan.subtitles?.assR2Key) {
    const assPath = join2(io.tmpDir, "subtitles.ass");
    if (!(await pathExists(assPath))) {
      await io.materializeByName(plan.subtitles.assR2Key, "subtitles.ass");
    }
  }
  await finalizeMaster({
    plan,
    io,
    videoNoAudioFile: videoFile,
    audioFile,
    durationSec: plan.estimatedSec,
    burnAssFileName: plan.subtitles?.assR2Key ? "subtitles.ass" : undefined,
  });
  // Task 120 — QC ALLÉGÉE : UNE SEULE sonde ffprobe du master, réutilisée par
  // la QC (analyse), les exports (timeout) et le finalize (stats) — le
  // résultat est mis en cache sur le job (le master ne change plus d'ici la
  // livraison ; tout rollback segments PURGE ce cache).
  const masterProbe = await probeMedia(masterTmp, io.tmpDir).catch(() => undefined);
  const report = await analyzeRenderedMaster({
    masterFile: masterTmp,
    tmpDir: io.tmpDir,
    plan,
    expectedDurationSec: plan.estimatedSec,
    subtitlesEnabled: Boolean(plan.subtitles?.assR2Key),
    cachedProbe: masterProbe,
    // Task 119 — CONTRAT UTILISATEUR : la volonté explicite de l'utilisateur
    // (durée demandée, ratio, voix, sous-titres) est vérifiée sur le master
    // réellement rendu — un écart est une issue CRITIQUE actionnable.
    ...(job.contract
      ? {
          userContract: {
            targetDurationSec: job.contract.targetDurationSec,
            aspectRatio: plan.aspectRatio,
            captionsRequired: job.contract.captionsRequired,
            narrationRequired: job.contract.narrationRequired,
          },
        }
      : {}),
  });
  // Task 95-c — rapport QC via la couche résiliente.
  // Task 127 — PERSISTANCE R2 DU MASTER : le master validé par la QC est
  // téléversé AVANT la livraison — le finalize sur une instance relais le
  // re-télécharge au lieu de re-rendre toute la chaîne.
  const { readFile: readMaster } = await import("node:fs/promises");
  const masterPreBody = await readMaster(masterTmp);
  const masterR2PreKey = await io.uploadRender(`renders/${job.id}/master.mp4`, masterPreBody, "renders");
  await writeCheckpointSet(
    JOBS_COLLECTION,
    job.id,
    { qcReport: report, "checkpoints.qcDone": true, "checkpoints.masterProbe": masterProbe ?? null, "checkpoints.masterR2PreKey": masterR2PreKey, updatedAt: nowIso() },
    job.userId,
  );
  await io.log(`QC : ${report.passed ? "OK" : `${report.issues.length} problème(s)`}.`);

  // Task 119 — CONTRAT UTILISATEUR NON RESPECTÉ : échec QC immédiat avec
  // message ACTIONNABLE (la reprise/resetToSegments existants s'appliquent).
  // Un rendu qui ne livre pas ce que l'utilisateur a demandé n'est pas un
  // « avertissement » : il ne doit pas partir en livraison.
  if (hasUserContractViolation(report)) {
    const violation = report.issues.find((i) => i.severity === "critical" && (i.kind === "aspect_ratio_mismatch" || i.kind === "captions_missing" || i.kind === "narration_missing" || (i.kind === "duration_mismatch" && i.detail.startsWith("Contrat utilisateur"))));
    if (violation) {
      throw new Error(`QC — contrat utilisateur non respecté : ${violation.detail}`);
    }
  }

  const decision = decideAutoFix(report, plan);
  if (decision.action === "fix" && job.autoFixRounds < MAX_AUTO_FIX_ROUNDS) {
    const completed = new Set(job.checkpoints.completedSegments);
    for (const index of decision.reRenderSegments) completed.delete(index);
    // Task 95-c — patch d'autofix via la couche résiliente (la sentinelle
    // FieldValue.increment part telle quelle à Firestore (sentinelle native).
    // une copie assainie — Task 95-b).
    await writeCheckpointSet(
      JOBS_COLLECTION,
      job.id,
      {
        autoFixRounds: FieldValue.increment(1),
        "checkpoints.completedSegments": [...completed],
        "checkpoints.audioDone": job.checkpoints.audioDone && !decision.rebuildAudio,
        "checkpoints.qcDone": false,
        // Task 120 — le master va être RE-RENDU : le cache de sonde est purgé.
        "checkpoints.masterProbe": null,
        stage: "segments",
        progress: computeJobProgress("segments", completed.size, plan.segments.length),
        updatedAt: nowIso(),
      },
      job.userId,
    );
    await io.log(`QC : correction automatique ronde ${job.autoFixRounds + 1}/${MAX_AUTO_FIX_ROUNDS} (${decision.reRenderSegments.length} segment(s), audio ${decision.rebuildAudio ? "oui" : "non"}).`);
    return { kind: "continue", stage: "segments", message: "Boucle de correction relancée." };
  }
  await moveToNextStage(job.id, job, "qc");
  return { kind: "continue", stage: job.stage, message: "QC validé." };
}

/** EXPORTS : formats dérivés (9:16 avec sous-titres Shorts, 1:1…). */
async function stageExports(job: RenderJob, io: EngineIo): Promise<StageOutcome> {
  const plan = job.plan!;
  const pending = job.exports.filter((e) => e.status === "pending");
  // Master présent dans le tmp ? Sinon (job d'export seul), matérialisation depuis R2.
  const { access } = await import("node:fs/promises");
  try {
    await access(`${io.tmpDir}/master.mp4`);
  } catch {
    if (plan.masterR2Key) {
      await io.materializeByName(plan.masterR2Key, "master.mp4");
      await io.log("Master téléchargé depuis le stockage pour les exports.");
    } else if (pending.length === 0) {
      // Aucun export à produire : le master tmp n'est PAS nécessaire ici —
      // l'étape finalize a sa propre garde cross-instance (resetToSegments).
      // Lancé une erreur ici consommait le budget retryCount d'un job dont
      // le rendu avait DÉJÀ réussi (QC validée) et le faisait échouer
      // définitivement pour rien (incident constaté en production : tick
      // interrompu pendant exports, tmp perdu, exports vides).
      await io.log("Exports : aucun format dérivé à produire — étape franchie sans master tmp.");
    } else if (job.checkpoints.masterR2PreKey) {
      // Task 127 — RESTAURATION R2 : le master a été PERSISTÉ à la QC
      // (masterR2PreKey) — re-téléchargé au lieu de re-rendre.
      try {
        await io.materializeByName(job.checkpoints.masterR2PreKey, "master.mp4");
        await io.log("Exports : master restauré depuis R2 (instance relais) — pas de re-rendu.");
      } catch {
        await resetToSegments(job.id, job, "master absent à l'étape exports (clé R2 cassée)");
        return { kind: "continue", stage: "segments", message: "Reprise : master absent, rendu relancé." };
      }
    } else {
      // Exports PENDANTS mais master irrécupérable (tmp perdu par une
      // interruption serverless, master pas encore téléversé) : rollback
      // déterministe vers les segments, le même garde que l'étape QC.
      await resetToSegments(job.id, job, "master absent à l'étape exports (instance relais)");
      return { kind: "continue", stage: "segments", message: "Reprise : master absent, rendu relancé." };
    }
  }
  // Task 134 — SOUS-AGENTS D'EXPORT : les formats dérivés (Shorts, TikTok,
  // Reels, carré…) sont indépendants (master figé, geometries distinctes,
  // fichiers export_<target>.mp4 séparés) — ils sont rendus en vague
  // parallèle bornée au lieu d'une boucle séquentielle. Le checkpoint est
  // CONSOLIDÉ UNE SEULE FOIS après la vague (contrat Firestore ~1 écriture/s) :
  // un export en échec reste "pending" et est repris au tick suivant.
  // Fichier ASS Shorts partagé : préparé UNE fois AVANT la vague (aucune
  // écriture concurrente du même fichier).
  if (pending.length > 0) {
    const planHasSubtitles = Boolean(plan.subtitles?.assR2Key);
    let shortsAssPrepared = false;
    if (planHasSubtitles && pending.some((t) => t.target.endsWith("9_16"))) {
      const project = await getOwnedProjectOrThrow(job.userId, job.projectId);
      const shortsAss = buildShortsAss(project, 1080, 1920);
      if (shortsAss) {
        await io.writeTmp("subtitles_shorts.ass", shortsAss);
        shortsAssPrepared = true;
      }
    }
    const { readFile, stat } = await import("node:fs/promises");
    const renderOneExport = async (target: (typeof pending)[number]): Promise<{ target: string; r2Key: string; sizeBytes: number }> => {
      const isVertical = target.target.endsWith("9_16");
      const assFileName = !planHasSubtitles
        ? undefined
        : isVertical && shortsAssPrepared
          ? "subtitles_shorts.ass"
          : "subtitles.ass";
      const outFile = await renderExportFormat({
        io,
        masterFile: join2(io.tmpDir, "master.mp4"),
        target: target.target,
        assFileName,
        // Task 120 — QC/sonde ALLÉGÉE : la durée du master est DÉJÀ connue du
        // job (sonde QC en cache, ou output posé au finalize des jobs
        // d'exports seuls) — aucune re-sonde ffprobe inutile.
        outputDurationSec: job.checkpoints.masterProbe?.durationSec ?? job.output?.durationSec,
      });
      const body = await readFile(outFile);
      const sizeBytes = (await stat(outFile)).size;
      const r2Key = await io.uploadRender(`renders/${job.id}/export_${target.target}.mp4`, body, "renders");
      return { target: target.target, r2Key, sizeBytes };
    };
    const wave = await runSubAgentWave("export_render", pending, VIDEO_LIMITS.maxParallelExportRenders, renderOneExport);
    // CONSOLIDATION UNIQUE : seuls les exports aboutis passent à "done" ;
    // les échecs isolés restent "pending" (reprise au tick suivant, budget
    // retryCount intact — un export raté ne fait pas échouer le rendu).
    for (const outcome of wave.outcomes) {
      if (outcome.status !== "fulfilled") continue;
      const done = outcome.value;
      const index = job.exports.findIndex((e) => e.target === done.target);
      if (index >= 0) job.exports[index] = { ...job.exports[index], r2Key: done.r2Key, sizeBytes: done.sizeBytes, status: "done" };
      await io.log(`Export ${done.target} livré (${Math.round(done.sizeBytes / 1024 / 1024)} Mo).`);
    }
    if (wave.rejected > 0) {
      await io.log(`${wave.rejected} export(s) en échec isolé — repris automatiquement au cycle suivant.`);
    }
    const doneCount = job.exports.filter((e) => e.status === "done").length;
    // Task 95-c — état des exports via la couche résiliente (checkpoint consolidé).
    await writeCheckpointSet(
      JOBS_COLLECTION,
      job.id,
      {
        exports: job.exports,
        progress: computeJobProgress("exports", doneCount, job.exports.length),
        updatedAt: nowIso(),
      },
      job.userId,
    );
  }
  const remaining = job.exports.filter((e) => e.status === "pending").length;
  if (remaining > 0) {
    return { kind: "continue", stage: "exports", message: `${remaining} export(s) restant(s).` };
  }
  await moveToNextStage(job.id, job, "exports");
  return { kind: "continue", stage: job.stage, message: "Exports terminés." };
}

/** FINALIZE : upload master, règlement wallet, projet terminé, purge, notification. */
async function stageFinalize(job: RenderJob, io: EngineIo): Promise<StageOutcome> {
  const plan = job.plan!;
  // Job d'export seul : pas de re-upload ni de re-facturation du master.
  if (job.mode === "exports_only") {
    const doneCount = job.exports.filter((e) => e.status === "done").length;
    if (job.billedMinor > 0) {
      await settleExportsBudget({ userId: job.userId, jobId: job.id, reservedMinor: job.billedMinor, targets: doneCount });
    }
    await writeCheckpointSet(
      JOBS_COLLECTION,
      job.id,
      { status: "completed", stage: "finalize", progress: 1, leaseOwner: FieldValue.delete(), leaseExpiresAt: 0, updatedAt: nowIso() },
      job.userId,
    );
    await cleanupJobTmp(job.id);
    await logSystem(job.projectId, `Exports additionnels livrés (${doneCount}).`).catch(() => undefined);
    await createNotification({
      userId: job.userId,
      type: "info",
      title: "Formats de diffusion prêts",
      body: `${doneCount} format(s) dérivé(s) (Shorts/TikTok/Reels/carré) disponibles dans le studio vidéo.`,
    }).catch(() => undefined);
    return { kind: "terminal", result: { jobId: job.id, status: "completed", stage: "finalize", done: true, continued: false, message: "Exports livrés." } };
  }
  // Task 95-c — IDEMPOTENCE FINALIZE (risque de double exécution après une
  // reprise quota) : si le master a déjà été téléversé (output/plan présents
  // dans le document fraîchement lu), on ne re-téléverse PAS et on ne
  // re-facture PAS (settle + stats) — seule l'écriture de l'état final
  // complété est (re)faite. Le premier passage garde le chemin nominal.
  const alreadyDelivered = Boolean(job.plan?.masterR2Key) || Boolean(job.output?.r2Key);
  if (alreadyDelivered) {
    await writeCheckpointSet(
      JOBS_COLLECTION,
      job.id,
      { status: "completed", stage: "finalize", progress: 1, leaseOwner: FieldValue.delete(), leaseExpiresAt: 0, updatedAt: nowIso() },
      job.userId,
    );
    await setProjectStatus(job.userId, job.projectId, "completed");
    await cleanupJobTmp(job.id);
    await logSystem(job.projectId, `Rendu ${job.id.slice(0, 8)} déjà livré — état final reconfirmé sans re-facturation (reprise après incident).`).catch(() => undefined);
    return { kind: "terminal", result: { jobId: job.id, status: "completed", stage: "finalize", done: true, continued: false, message: "Rendu déjà livré — état final confirmé." } };
  }
  if (!(await pathExists(join2(io.tmpDir, "master.mp4")))) {
    // Task 127 — RESTAURATION R2 : le master a été PERSISTÉ à la QC
    // (masterR2PreKey) — une instance relais le re-télécharge au lieu de
    // re-rendre. Le re-rendu ne reste que sans clé/cassée.
    const preKey = job.checkpoints.masterR2PreKey;
    let restored = false;
    if (preKey) {
      try {
        await io.materializeByName(preKey, "master.mp4");
        restored = true;
      } catch {
        restored = false;
      }
    }
    if (!restored) {
      await resetToSegments(job.id, job, "master absent sur cette instance avant livraison");
      return { kind: "continue", stage: "segments", message: "Reprise : master absent, rendu relancé." };
    }
    await io.log("Master restauré depuis R2 (instance relais) — livraison sans re-rendu.");
  }
  const uploaded = await uploadMaster({
    io,
    masterFile: join2(io.tmpDir, "master.mp4"),
    projectId: job.projectId,
    jobId: job.id,
    // Task 120 — QC ALLÉGÉE : métadonnées du master déjà sondées à la QC
    // (cache job) — le finalize ne re-sonde PAS le même fichier.
    probe: job.checkpoints.masterProbe ?? undefined,
  });
  const actualMinor = await settleRenderBudget({
    userId: job.userId,
    jobId: job.id,
    estimate: estimateRenderCost({ durationSec: plan.estimatedSec, resolution: plan.resolution }),
    actualDurationSec: uploaded.durationSec,
  });
  await writeCheckpointSet(
    JOBS_COLLECTION,
    job.id,
    {
      status: "completed",
      stage: "finalize",
      progress: 1,
      leaseOwner: FieldValue.delete(),
      leaseExpiresAt: 0,
      "plan.masterR2Key": uploaded.r2Key,
      output: { r2Key: uploaded.r2Key, sizeBytes: uploaded.sizeBytes, durationSec: uploaded.durationSec, width: uploaded.width, height: uploaded.height },
      billedMinor: actualMinor,
      updatedAt: nowIso(),
    },
    job.userId,
  );
  await setProjectStatus(job.userId, job.projectId, "completed");
  await adminDb.collection("videoProjects").doc(job.projectId).set(
    { stats: { renderedSeconds: uploaded.durationSec, billedMinor: FieldValue.increment(actualMinor) }, updatedAt: nowIso() },
    { merge: true },
  );
  await cleanupJobTmp(job.id);
  await logSystem(job.projectId, `Rendu ${job.id.slice(0, 8)} TERMINÉ : ${uploaded.durationSec.toFixed(1)} s, ${Math.round(uploaded.sizeBytes / 1024 / 1024)} Mo, ${job.exports.filter((e) => e.status === "done").length} export(s). Facturé ${actualMinor} minor.`).catch(() => undefined);
  await createNotification({
    userId: job.userId,
    type: "info",
    title: "Vidéo prête",
    body: `Votre rendu (${uploaded.durationSec.toFixed(0)} s, ${plan.resolution}) est disponible dans le studio vidéo, avec ses exports de diffusion.`,
  }).catch(() => undefined);
  return { kind: "terminal", result: { jobId: job.id, status: "completed", stage: "finalize", done: true, continued: false, message: "Rendu livré." } };
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
    log: async (message) => {
      await logSystem(job.projectId, message);
      // Fil conducteur : le dernier journal est posé SUR le job (diagnostic
      // production immédiat — quelles étapes ont réellement tourné).
      await adminDb
        .collection(JOBS_COLLECTION)
        .doc(job.id)
        .set({ lastLog: message.slice(0, 280) }, { merge: true })
        .catch(() => undefined);
    },
  };
}

/** Existence d'un chemin sur le disque LOCAL de cette instance (jamais jeté). */
async function pathExists(path: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
function segmentFileName(index: number): string {
  return `segment_${String(index).padStart(4, "0")}.mp4`;
}

/**
 * Task 127 — RESTAURATION R2 : matérialise depuis R2 les artefacts de rendu
 * perdus par une instance relais (segments rendus, montage sans audio,
 * master pré-livraison). Retourne le détail de ce qui a été restauré —
 * l'appelant décide ensuite s'il peut poursuivre SANS re-rendu ou si le
 * resetToSegments déterministe reste nécessaire.
 */
async function restoreRenderedArtifactsFromR2(
  job: RenderJob,
  io: EngineIo,
): Promise<{ segments: number; videoNoaudio: boolean; master: boolean }> {
  let segments = 0;
  const map = job.checkpoints.segmentsR2 ?? {};
  for (const index of job.checkpoints.completedSegments) {
    const key = map[String(index)];
    if (!key) continue;
    const file = `${io.tmpDir}/${segmentFileName(index)}`;
    if (await pathExists(file)) continue;
    await io.materializeByName(key, segmentFileName(index));
    segments += 1;
  }
  let videoNoaudio = false;
  if (job.checkpoints.videoNoaudioR2 && !(await pathExists(`${io.tmpDir}/video_noaudio.mp4`))) {
    await io.materializeByName(job.checkpoints.videoNoaudioR2, "video_noaudio.mp4");
    videoNoaudio = true;
  }
  let master = false;
  if (job.checkpoints.masterR2PreKey && !(await pathExists(`${io.tmpDir}/master.mp4`))) {
    await io.materializeByName(job.checkpoints.masterR2PreKey, "master.mp4");
    master = true;
  }
  return { segments, videoNoaudio, master };
}

/**
 * Task 127 — TOUS les segments complétés ont-ils une clé R2 persistée ?
 * (Condition pour éviter un re-rendu complet sur instance relais.)
 */
function allCompletedSegmentsPersisted(job: RenderJob): boolean {
  const map = job.checkpoints.segmentsR2 ?? {};
  return job.checkpoints.completedSegments.every((index) => Boolean(map[String(index)]));
}

/**
 * Remise déterministe au stage « segments » : les fichiers intermédiaires ne
 * survivent pas d'une instance lambda à l'autre (/tmp local). Les images se
 * re-téléchargent depuis R2 et le rendu repart du début des segments —
 * correct à toute étape car TOUTE la production est déterministe.
 */
async function resetToSegments(jobId: string, job: RenderJob, reason: string): Promise<void> {
  const totalSegments = job.plan?.segments?.length ?? 0;
  await writeCheckpointSet(
    JOBS_COLLECTION,
    jobId,
    {
      stage: "segments",
      progress: computeJobProgress("segments", 0, totalSegments),
      "checkpoints.completedSegments": [],
      "checkpoints.transitionsDone": false,
      "checkpoints.audioDone": false,
      "checkpoints.subtitlesDone": false,
      "checkpoints.qcDone": false,
      // Task 120 — le master va être RE-RENDU : le cache de sonde est purgé.
      "checkpoints.masterProbe": null,
      // Task 127 — les artefacts persistés sont PÉRIMÉS après un rollback
      // (les segments seront re-rendus) : les clés R2 sont purgées pour ne
      // jamais restaurer un artefact obsolète.
      "checkpoints.segmentsR2": {},
      "checkpoints.videoNoaudioR2": FieldValue.delete(),
      "checkpoints.masterR2PreKey": FieldValue.delete(),
      updatedAt: nowIso(),
    },
    job.userId,
  );
  job.stage = "segments";
  job.checkpoints = {
    ...job.checkpoints,
    completedSegments: [],
    transitionsDone: false,
    audioDone: false,
    subtitlesDone: false,
    qcDone: false,
    masterProbe: null,
    segmentsR2: {},
    videoNoaudioR2: undefined,
    masterR2PreKey: undefined,
  };
  await logSystem(
    job.projectId,
    `Rendu ${jobId.slice(0, 8)} : ${reason} — reprise déterministe depuis les segments.`,
  ).catch(() => undefined);
}

// Exports consommés par l'orchestrateur de ticks (render-queue.ts).
export {
  stagePlan,
  stageDownload,
  stageSegments,
  stageTransitions,
  stageAudio,
  stageSubtitles,
  stageQc,
  stageExports,
  stageFinalize,
  buildEngineIo,
  pathExists,
  restoreRenderedArtifactsFromR2,
  allCompletedSegmentsPersisted,
  resetToSegments,
};
