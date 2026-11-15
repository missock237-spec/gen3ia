import "server-only";

/**
 * GEN3IA VIDEO AGENT — MACHINE D'ÉTAPES DE PRODUCTION (module 20, partie 3,
 * extraite de production-queue.ts).
 *
 * Les 7 étapes du pipeline autopilote (project → plan → script → assets →
 * voice → render → done), UNE étape par tick, chacune idempotente :
 *   - project/plan/script : mêmes appels que les routes POST du studio ;
 *   - assets : VAGUE PARALLÈLE avec chevauchement assets∥voice (Task 120),
 *     tolérance par scène (Task 106-c), clips vidéo IA Agnes (Task 154) ;
 *   - voice : narrations par lots + piste voix synchronisée + lit musical ;
 *   - render : enfile le rendu réel (module 19) avec son propre budget ;
 *   - done : miroir du job de rendu — la production ne termine qu'avec lui.
 *
 * Code déplacé tel quel — aucun changement de comportement.
 */

import {
  getOwnedProjectOrThrow,
  patchProject,
} from "@/lib/video/project-service";
import { applyProductionPlan } from "@/lib/video/director-service";
import { generateScript } from "@/lib/video/script-service";
import { generateSceneImage, findSceneImage } from "@/lib/video/image-bridge";
import { isSceneVideoServiceEnabled, SceneVideoUnavailableError, startSceneVideoTask, awaitSceneVideoTask, findSceneVideo, type SceneVideoTaskState } from "@/lib/video/scene-video-service";
import { billImageGeneration, billTts } from "@/lib/video/credits";
import { resolvePreferredVoice, withPlatformVoiceFallback, attachRecordingAsNarration } from "@/lib/video/voice-service";
import { listAssets } from "@/lib/video/asset-service";
import { syncVoiceTrack, applyTimelinePatch } from "@/lib/video/timeline-service";
import { ensureMusicBed } from "@/lib/video/audio-engine";
import { isOwnedVideoKey } from "@/lib/video/storage";
import { startRenderJob, getJob } from "@/lib/video/render-queue";
import type { VideoProject, ScriptScene, VoiceProfile, VideoTimeline } from "@/lib/video/types";
import { mergePresetEffects, PRESET_MOTION, parseEffectPreset } from "@/lib/video/effect-presets";
import { buildMotion } from "@/lib/video/motion-service";
import { mapWithConcurrency } from "@/lib/video/concurrency";
import { classifyTickError } from "@/lib/video/queue-resume";
import { writeCheckpointSet } from "@/lib/db/firestore-resilient";
import { VideoQuotaError, VIDEO_LIMITS, RenderRequestSchema } from "@/lib/video/security";
import {
  ASSET_BATCH_SIZE,
  MAX_SCENE_FAILURES,
  PRODUCTION_JOBS_COLLECTION,
  PRODUCTION_STAGES,
  SCENE_VIDEO_MIN_START_BUDGET_MS,
  type ProductionStageTimelineEntry,
  type VideoProductionJob,
} from "@/lib/video/production-job";
import {
  appendJobWarning,
  computeProductionProgress,
  countPermanentlyIgnoredScenes,
  firstSceneNeedingRetry,
  nextAssetWindow,
  recordSceneFailure,
  sceneFailureKey,
  sceneWarningMessage,
  shouldSkipScene,
} from "@/lib/video/production-job";
import { nowIso } from "@/lib/video/queue-core";

/** Résultat d'exécution d'une étape de production (consommé par le tick). */
export type ProductionStageResult =
  | { action: "advance"; detail?: string }
  | { action: "stay"; detail?: string; delaySeconds?: number; mirrorProgress?: number }
  | { action: "terminal-completed" }
  | { action: "terminal-failed"; message: string };

/** Marque le début de l'étape courante dans la timeline du job (idempotent). */
export async function ensureStageEntry(job: VideoProductionJob): Promise<void> {
  if (job.timeline.some((e) => e.stage === job.stage)) return;
  const timeline: ProductionStageTimelineEntry[] = [...job.timeline, { stage: job.stage, startedAt: nowIso() }];
  job.timeline = timeline;
  // Task 95-d — écriture via la couche résiliente (Firestore unique moteur, Task 108).
  await writeCheckpointSet(PRODUCTION_JOBS_COLLECTION, job.id, { timeline, updatedAt: nowIso() }, job.userId).catch(() => undefined);
}

export async function moveToNextProductionStage(job: VideoProductionJob, detail?: string): Promise<void> {
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
  // Task 95-d — écriture via la couche résiliente (Firestore unique moteur, Task 108).
  await writeCheckpointSet(PRODUCTION_JOBS_COLLECTION, job.id, patch, job.userId);
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

// ────────────────────────────────────────────────────────────────────────────
// Task 120 — chevauchement assets∥voice : helpers de la vague parallèle
// ────────────────────────────────────────────────────────────────────────────

/** Résultat d'une promesse sans rejet (équivalent mono-promesse d'allSettled). */
type Settled<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };

/** Exécute une tâche sans jamais la laisser rejeter (résultat discriminé). */
async function settle<T>(task: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { status: "fulfilled", value: await task() };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

/** Sortie NARRATION d'une scène de la vague (classification locale). */
type SceneNarrationOutcome =
  | { status: "done" }
  | { status: "disabled" }
  | { status: "deferred" }
  | { status: "fatal"; error: unknown };

/**
 * Classe un échec de narration SURVENU PENDANT la vague assets : fatal →
 * tolérance par scène (« voice:… », retentée à l'étape voice) ; quota /
 * transitoire → DIFFÉRÉ à l'étape voice (qui applique le régime adapté du
 * tick) — un incident TTS ne bloque JAMAIS la vague des visuels.
 */
function narrationOutcome(reason: unknown): SceneNarrationOutcome {
  return classifyTickError(reason) === "fatal" ? { status: "fatal", error: reason } : { status: "deferred" };
}

/** Sortie IMAGE + NARRATION + CLIP VIDÉO IA d'une scène de la vague parallèle. */
interface SceneWaveResult {
  image: { status: "ok"; generated: boolean } | { status: "ignored" } | { status: "fatal"; error: unknown };
  narration: SceneNarrationOutcome;
  /**
   * Task 154 — clip vidéo IA (Agnes Video, mode keyframe). JAMAIS bloquant
   * pour la production : un échec (indisponibilité, crédit, quota) dégrade
   * la scène en animation image Ken Burns avec avertissement utilisateur.
   *
   * `pending` = la tâche Agnes vit toujours (échéance du tick atteinte) :
   * le curseur s'ARRÊTE sur cette scène, le tick suivant RE-SONDE la même
   * tâche (reprise inter-ticks — jamais de re-génération). `not_started` =
   * budget trop court pour DÉMARRER (ticks « sondage » 20–55 s) : idem.
   */
  video: { status: "generated" | "reused" | "skipped" | "failed" | "pending" | "not_started"; error?: string };
}

/** Voix résolue + narrations déjà posées (chevauchement assets∥voice). */
interface VoiceOverlapPlan {
  voice: VoiceProfile;
  /** Scènes déjà narrées (idempotence : jamais de double synthèse). */
  narratedSceneIds: Set<string>;
}

/**
 * Prépare le chevauchement : résout la voix (repli plateforme inclus) et les
 * narrations déjà posées. null → PAS de chevauchement (narration désactivée
 * ou résolution impossible) : l'étape voice garde son comportement complet.
 */
async function prepareVoiceOverlap(job: VideoProductionJob, project: VideoProject): Promise<VoiceOverlapPlan | null> {
  if (job.options?.voiceEnabled === false) return null;
  try {
    const voice = withPlatformVoiceFallback(await resolvePreferredVoice(job.userId, project));
    const narrations = await listAssets(job.userId, job.projectId, "audio_narration");
    return { voice, narratedSceneIds: new Set(narrations.filter((a) => a.sceneId).map((a) => a.sceneId!)) };
  } catch {
    return null; // voix/store indisponible : narration laissée à l'étape voice
  }
}

/**
 * Tickets de NOUVELLES images disponibles pour la vague (plafond strict du
 * projet, VIDEO_LIMITS.maxGeneratedImages) : la vérification interne par
 * scène (assertProjectImageBudget) ne voit pas les générations simultanées
 * de la vague — les tickets bornent le départ des générations au RESTE du
 * plafond. Store illisible → Infinity (la garde par scène tranche).
 */
async function remainingImageTickets(job: VideoProductionJob): Promise<number> {
  try {
    const images = await listAssets(job.userId, job.projectId, "image");
    const generatedCount = images.filter((a) => a.origin === "generated").length;
    return Math.max(0, VIDEO_LIMITS.maxGeneratedImages - generatedCount);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Tâche de narration d'UNE scène (voie A enregistrement / voie B TTS
 * facturée au caractère réel) — partagée par l'étape voice et le
 * chevauchement assets∥voice (Task 120). Retourne les caractères facturés.
 */
async function narrationTaskForScene(
  job: VideoProductionJob,
  scene: ScriptScene,
  voice: VoiceProfile,
  alreadyNarrated: boolean,
): Promise<number> {
  if (alreadyNarrated) return 0;
  if (voice.origin === "recording" && voice.sampleR2Key && isOwnedVideoKey(job.userId, voice.sampleR2Key)) {
    // Voie A : enregistrement utilisateur (usage direct de l'échantillon).
    await attachRecordingAsNarration({
      userId: job.userId,
      projectId: job.projectId,
      sceneId: scene.id,
      sampleR2Key: voice.sampleR2Key,
    });
    return 0;
  }
  // Voie B (TTS ElevenLabs) SUPPRIMÉE : la synthèse vocale externe a été
  // retirée du projet — sans enregistrement utilisateur, la scène reste
  // muette (sous-titres préservés au montage). Aucun caractère facturé.
  return 0;
}

/**
 * ASSETS (Task 120 — VAGUE PARALLÈLE + CHEVAUCHEMENT assets∥voice) :
 * visuels de scènes par lots de ≤ ASSET_BATCH_SIZE par tick, chaque scène
 * étant traitée par ≤ VIDEO_LIMITS.maxParallelAssetGenerations workers
 * simultanés (pool maison concurrency.ts — aucune dépendance npm).
 *
 * CHEVAUCHEMENT : la narration d'une scène ne dépend QUE du scénario (pas
 * des images) — elle est générée DANS LA MÊME VAGUE que l'image de sa scène
 * (image et TTS en parallèle par scène). L'étape « voice » suivante devient
 * une finalisation idempotente : les scènes déjà narrées sont traversées
 * sans re-synthèse ni re-facturation (listAssets), la piste voix + le lit
 * musical y sont posés comme avant.
 *
 * CONTRATS PRÉSERVÉS (tests render-queue-resume / production-queue-resume) :
 * - sceneCursor checkpoint UNIQUE consolidé après la vague (limite
 *   Firestore ~1 écriture/s/doc) — la reprise reprend au curseur ;
 * - tolérance PAR SCÈNE (clés « assets:… » / « voice:… » distinctes) : les
 *   échecs FATALS d'image sont isolés par scène (compteur, warning, curseur
 *   avancé, lot continu) ; les échecs QUOTA/TRANSITOIRES d'image
 *   interrompent la vague SANS checkpoint (régime de reprise du tick,
 *   budget intact) — re-traitement idempotent du lot au retour ;
 * - détection SYSTÉMIQUE image : aucune réussite dans le lot + au moins un
 *   échec fatal → la première erreur fatale remonte (panne moteur) ;
 * - échecs de NARRATION : JAMAIS bloquants pour la vague (fatal → compteur
 *   « voice:… » retenté à l'étape voice ; transitoire → différé à l'étape
 *   voice qui le classera correctement) ;
 * - budget images : porte de tickets locale — la vérification par scène
 *   (assertProjectImageBudget) ne voit pas les générations simultanées de
 *   la vague, les tickets bornent les NOUVELLES images au reste du plafond
 *   strict sans jamais le dépasser ;
 * - facturation : images NOUVELLES générées ce tick (billImageGeneration
 *   une fois par vague), TTS au caractère réel PAR narration (billTts).
 *
 * HONNÊTETÉ : la bible visuelle (Consistency Engine) évolue au fil des
 * références établies — en vague, les scènes simultanées partent du même
 * instantané (les scènes démarrées APRÈS une génération bénéficient de la
 * bible rafraîchie, comme le lot client séquentiel).
 */
async function stageAssets(job: VideoProductionJob, timeBudgetMs?: number): Promise<ProductionStageResult> {
  const project = await getOwnedProjectOrThrow(job.userId, job.projectId);
  if (!project.script) throw new Error("Scénario absent à l'étape des visuels.");
  const scenes = project.script.scenes;
  if (scenes.length === 0) throw new Error("Scénario vide : aucune scène à illustrer.");

  const deadlineMs = typeof timeBudgetMs === "number" && timeBudgetMs > 0 ? Date.now() + timeBudgetMs : null;
  const window = nextAssetWindow(scenes, job.sceneCursor, ASSET_BATCH_SIZE);
  let generated = 0;
  let narrated = 0;
  // Task 106-c — état de tolérance (persisté sur le job à chaque checkpoint).
  let sceneFailures = job.sceneFailures ?? {};
  let warnings = job.warnings ?? [];
  // Task 154 (reprise inter-ticks) — tâches Agnes Video vivantes : re-sondées
  // au lieu d'être re-générées (idempotence économique par scène).
  const sceneVideoTasks: Record<string, SceneVideoTaskState> = { ...(job.sceneVideoTasks ?? {}) };
  const sceneVideoTasksAtStart = JSON.stringify(job.sceneVideoTasks ?? {});
  const cursorAtTickStart = job.sceneCursor;
  const failuresAtTickStart = JSON.stringify(sceneFailures);

  // Task 120 — préparation du CHEVAUCHEMENT voice : voix + narrations déjà
  // posées (idempotence). Indisponible (voix irrésolvable, store illisible,
  // narration désactivée) → pas de chevauchement, l'étape voice suivante
  // garde son comportement historique complet.
  const voicePlan = await prepareVoiceOverlap(job, project);

  // Task 120 — porte de budget locale (plafond strict d'images) : tickets de
  // NOUVELLES générations disponibles pour cette vague.
  let newImageTickets = await remainingImageTickets(job);

  // VAGUE PARALLÈLE : chaque worker traite UNE scène — son IMAGE et sa
  // NARRATION démarrent ENSEMBLE (chevauchement assets∥voice) et leurs
  // échecs sont classés séparément : image quota/transitoire → rejet du
  // worker (propagation au régime du tick après la vague) ; image fatale →
  // tolérance par scène ; narration → jamais bloquante pour la vague.
  // NOTE bible visuelle : les scènes de la vague partent du même instantané
  // (≤ maxParallelAssetGenerations ≤ ASSET_BATCH_SIZE démarrent ensemble) ;
  // la bible rafraîchie profite au PROCHAIN lot (relecture à l'entrée du tick
  // suivant — même moteur de cohérence, aucun contournement).
  const outcomes = await mapWithConcurrency(
    window.batch,
    Math.max(1, VIDEO_LIMITS.maxParallelAssetGenerations),
    async (scene): Promise<SceneWaveResult> => {
      const imageTask = settle(async () => {
        if (shouldSkipScene(sceneFailures, sceneFailureKey("assets", scene.id))) {
          return { status: "ignored" as const };
        }
        if (newImageTickets > 0) {
          newImageTickets -= 1; // ticket consommé AVANT la génération (course)
        }
        // Sinon : plus de ticket → assertProjectImageBudget tranche lui-même
        // (VideoQuotaError fatal → tolérance par scène existante).
        const result = await generateSceneImage({ userId: job.userId, project, scene });
        if (result.generated) {
          generated += 1;
        } else {
          newImageTickets += 1; // réutilisation : ticket rendu au reste du plafond
        }
        return { status: "ok" as const, generated: result.generated };
      });
      const narrationTask = voicePlan
        ? settle(async () => {
            const charactersUsed = await narrationTaskForScene(job, scene, voicePlan.voice, voicePlan.narratedSceneIds.has(scene.id));
            if (charactersUsed > 0) {
              // Facturation au caractère réel, PAR narration (comme la boucle
              // historique de l'étape voice — référence unique par appel).
              await billTts(job.userId, job.projectId, charactersUsed);
            }
            return { status: "done" as const };
          })
        : Promise.resolve({ status: "fulfilled" as const, value: { status: "disabled" as const } });
      const imageSettled = await imageTask;
      // Task 154 — CLIP VIDÉO IA : démarre APRÈS l'image (mode keyframe —
      // l'image cohérente devient la first frame du clip) et se poursuit en
      // parallèle de la narration. Échec → dégradation Ken Burns (jamais
      // bloquant) : le rendu n'a simplement pas de videoR2Key pour la scène.
      //
      // REPRISE INTER-TICKS : une tâche Agnes DÉMARRÉE mais non terminée à
      // l'échéance du tick reste dans sceneVideoTasks (persistée sur le job)
      // — le tick suivant RE-SONDE la même tâche au lieu de re-générer
      // (jamais deux coûts fournisseur pour une même scène). Les ticks
      // « sondage » courts (20–55 s) ne DÉMARRENT rien : sans budget minimal
      // ils attendent le tick worker (bail 230 s).
      const videoDeadlineMs = deadlineMs !== null ? deadlineMs - 10_000 : null; // marge avant l'échéance du tick
      const videoTask: Promise<{ status: "fulfilled"; value: { status: "generated" | "reused" | "skipped" | "failed" | "pending" | "not_started"; error?: string } } | { status: "rejected"; reason: unknown }> =
        imageSettled.status === "rejected"
          ? Promise.resolve({ status: "fulfilled" as const, value: { status: "skipped" as const } })
          : settle(async () => {
              if (job.options?.videoClips === false || !isSceneVideoServiceEnabled()) {
                return { status: "skipped" as const };
              }
              try {
                // 1. Tâche vivante → RE-SONDAGE (jamais de re-génération).
                const live = sceneVideoTasks[scene.id];
                if (live) {
                  const outcome = await awaitSceneVideoTask({
                    userId: job.userId,
                    project,
                    scene,
                    task: live,
                    ...(videoDeadlineMs !== null ? { deadlineMs: videoDeadlineMs } : {}),
                  });
                  if (outcome.status === "pending") {
                    return { status: "pending" as const };
                  }
                  delete sceneVideoTasks[scene.id];
                  if (outcome.status === "failed") {
                    return { status: "failed" as const, error: outcome.error };
                  }
                  return { status: "generated" as const };
                }
                // 2. Clip déjà finalisé ? (idempotence — y compris par un tick
                // précédent mort entre register et checkpoint.)
                const existing = await findSceneVideo(job.userId, project.id, scene.id);
                if (existing) {
                  return { status: "reused" as const };
                }
                // 3. NOUVELLE tâche : budget minimal requis (maturation 60–180 s
                // côté Agnes) — un tick trop court ne démarre rien.
                if (videoDeadlineMs !== null && Date.now() > videoDeadlineMs - SCENE_VIDEO_MIN_START_BUDGET_MS) {
                  return { status: "not_started" as const };
                }
                const image = imageSettled.status === "fulfilled" && imageSettled.value.status === "ok"
                  ? await findSceneImage(job.userId, project.id, scene.id)
                  : null;
                if (!image) {
                  return { status: "skipped" as const };
                }
                const task = await startSceneVideoTask({ userId: job.userId, project, scene, image });
                sceneVideoTasks[scene.id] = task;
                // Persistance IMMÉDIATE (survie aux crashes) : la tâche
                // démarrée est connue du job AVANT le premier sondage.
                await writeCheckpointSet(
                  PRODUCTION_JOBS_COLLECTION,
                  job.id,
                  { sceneVideoTasks, updatedAt: nowIso() },
                  job.userId,
                ).catch(() => undefined);
                const outcome = await awaitSceneVideoTask({
                  userId: job.userId,
                  project,
                  scene,
                  task,
                  ...(videoDeadlineMs !== null ? { deadlineMs: videoDeadlineMs } : {}),
                });
                if (outcome.status === "pending") {
                  return { status: "pending" as const };
                }
                delete sceneVideoTasks[scene.id];
                if (outcome.status === "failed") {
                  return { status: "failed" as const, error: outcome.error };
                }
                return { status: "generated" as const };
              } catch (error) {
                if (error instanceof SceneVideoUnavailableError || error instanceof VideoQuotaError) {
                  return { status: "failed" as const, error: error.message };
                }
                // Fonds insuffisants (402 wallet) → dégradation contrôlée : la
                // scène garde son animation image, l'utilisateur est averti.
                const message = error instanceof Error ? error.message : String(error);
                if (/insufficient|fonds|solde|wallet/i.test(message)) {
                  return { status: "failed" as const, error: message };
                }
                throw error;
              }
            });
      const narrationSettled = await narrationTask;
      const videoSettled = await videoTask;
      const videoResult = videoSettled.status === "rejected"
        ? { status: "failed" as const, error: videoSettled.reason instanceof Error ? videoSettled.reason.message : String(videoSettled.reason) }
        : videoSettled.value;
      if (imageSettled.status === "rejected") {
        // Image quota/transitoire → PROPAGATION (rejet du worker, isolé par
        // le pool — la première dans l'ORDRE remonte après la vague).
        if (classifyTickError(imageSettled.reason) !== "fatal") throw imageSettled.reason;
        return {
          image: { status: "fatal", error: imageSettled.reason },
          narration: narrationSettled.status === "rejected" ? narrationOutcome(narrationSettled.reason) : narrationSettled.value,
          video: videoResult,
        };
      }
      return {
        image: imageSettled.value,
        narration: narrationSettled.status === "rejected" ? narrationOutcome(narrationSettled.reason) : narrationSettled.value,
        video: videoResult,
      };
    },
    {
      // Budget temps du tick honoré AVANT chaque démarrage de scène (le
      // checkpoint maître reprend les non-démarrées au prochain tick).
      shouldStart: () => deadlineMs === null || Date.now() < deadlineMs,
    },
  );

  // Application DÉTERMINISTE (ordre des scènes) des résultats de la vague.
  let imageFatalInBatch = 0;
  let imageSucceededInBatch = 0;
  let firstImageFatal: unknown = null;
  let firstTickError: unknown;
  let haveTickError = false;
  let pendingSceneVideos = 0;
  let cursor = cursorAtTickStart;
  for (let i = 0; i < window.batch.length; i += 1) {
    const outcome = outcomes[i];
    const scene = window.batch[i];
    const sceneIndex = cursorAtTickStart + i;
    if (outcome.status === "skipped") break; // non démarrée (budget temps)
    if (outcome.status === "rejected") {
      // Erreur transitoire/quota image : le régime de reprise du tick prend
      // le relais (comme l'interruption de la boucle historique) — les
      // scènes suivantes (même réussies) seront re-traitées idempotemment.
      if (!haveTickError) {
        firstTickError = outcome.reason;
        haveTickError = true;
      }
      break;
    }
    const result = outcome.value;
    if (result.image.status === "fatal") {
      sceneFailures = recordSceneFailure(sceneFailures, sceneFailureKey("assets", scene.id));
      const permanentlyIgnored = shouldSkipScene(sceneFailures, sceneFailureKey("assets", scene.id));
      warnings = appendJobWarning(
        warnings,
        sceneWarningMessage({
          label: "image",
          sceneNumber: sceneIndex + 1,
          failures: sceneFailures[sceneFailureKey("assets", scene.id)],
          permanentlyIgnored,
          cause: result.image.error instanceof Error ? result.image.error.message : String(result.image.error),
        }),
      );
      imageFatalInBatch += 1;
      if (firstImageFatal === null) firstImageFatal = result.image.error;
    } else if (result.image.status === "ok") {
      imageSucceededInBatch += 1;
    }
    if (result.narration.status === "fatal") {
      // Tolérance PAR SCÈNE voix (clé « voice:… ») — retentée à l'étape voice.
      sceneFailures = recordSceneFailure(sceneFailures, sceneFailureKey("voice", scene.id));
      const permanentlyIgnored = shouldSkipScene(sceneFailures, sceneFailureKey("voice", scene.id));
      warnings = appendJobWarning(
        warnings,
        sceneWarningMessage({
          label: "narration",
          sceneNumber: sceneIndex + 1,
          failures: sceneFailures[sceneFailureKey("voice", scene.id)],
          permanentlyIgnored,
          cause: result.narration.error instanceof Error ? result.narration.error.message : String(result.narration.error),
        }),
      );
    } else if (result.narration.status === "done") {
      narrated += 1;
    }
    // Task 154 — clip vidéo IA : avertissement HONNÊTE en cas d'échec (la
    // scène est livrée en animation image Ken Burns, jamais bloquée).
    if (result.video.status === "failed") {
      warnings = appendJobWarning(
        warnings,
        `Clip vidéo IA de la scène ${sceneIndex + 1} non généré (${(result.video.error ?? "raison inconnue").slice(0, 160)}) — animation image utilisée.`,
      );
    }
    // Task 154 (reprise inter-ticks) — tâche vivante ou non démarrée : le
    // curseur S'ARRÊTE sur cette scène (sa vidéo mûrit côté Agnes, le tick
    // suivant re-sonde la même tâche — les scènes suivantes, même réussies,
    // seront re-validées idempotemment, sans re-génération).
    if (result.video.status === "pending" || result.video.status === "not_started") {
      pendingSceneVideos += 1;
      break;
    }
    cursor = sceneIndex + 1;
  }
  job.sceneCursor = cursor;

  // Erreur transitoire/quota image → régime de reprise du tick (le
  // checkpoint N'EST PAS écrit : re-traitement idempotent du lot au retour,
  // comportement historique de l'interruption immédiate).
  if (haveTickError) {
    throw firstTickError instanceof Error ? firstTickError : new Error(String(firstTickError));
  }

  // Task 106-c — SYSTÉMIQUE image : aucune réussite dans le lot + au moins un
  // échec fatal → on RENVOIE la première erreur fatale (moteur de visuels
  // indisponible) : le régime de reprise du tick la traite exactement comme
  // avant (re-file 20 s sous budget / échec définitif + notification).
  if (imageFatalInBatch > 0 && imageSucceededInBatch === 0) {
    throw firstImageFatal instanceof Error ? firstImageFatal : new Error(String(firstImageFatal));
  }

  // Task 106-fix — checkpoint CONSOLIDÉ (un par tick) : curseur, progression,
  // tolérance par scène (sceneFailures/warnings) et tâches vidéo vivantes —
  // persistés ensemble.
  if (
    job.sceneCursor !== cursorAtTickStart ||
    JSON.stringify(sceneFailures) !== failuresAtTickStart ||
    JSON.stringify(sceneVideoTasks) !== sceneVideoTasksAtStart
  ) {
    await writeCheckpointSet(
      PRODUCTION_JOBS_COLLECTION,
      job.id,
      {
        sceneCursor: job.sceneCursor,
        progress: computeProductionProgress("assets", job.sceneCursor, scenes.length),
        sceneFailures,
        warnings,
        sceneVideoTasks,
        updatedAt: nowIso(),
      },
      job.userId,
    );
    job.sceneVideoTasks = sceneVideoTasks;
  }

  // Facturation EXISTANTE honorée : uniquement les images NOUVELLEMENT
  // générées CE tick (les réutilisations et les scènes ignorées ne coûtent
  // rien) — AVANT toute sortie de l'étape (retente ou terminaison incluse).
  if (generated > 0) {
    await billImageGeneration(job.userId, job.projectId, generated);
  }

  // Fin de lot : retentes des scènes en échec (curseur ramené à la première
  // scène à retenter — les réussies seront simplement réutilisées).
  const retryIndex = firstSceneNeedingRetry(scenes, sceneFailures, "assets");
  if (retryIndex >= 0 && retryIndex < job.sceneCursor && job.sceneCursor >= scenes.length) {
    job.sceneCursor = retryIndex;
    await writeCheckpointSet(
      PRODUCTION_JOBS_COLLECTION,
      job.id,
      { sceneCursor: retryIndex, sceneFailures, warnings, updatedAt: nowIso() },
      job.userId,
    );
    return {
      action: "stay",
      detail: `${job.sceneCursor}/${scenes.length} visuels — scène(s) en échec à reprendre au prochain tick (tolérance par scène).`,
    };
  }

  if (job.sceneCursor >= scenes.length) {
    const ignored = countPermanentlyIgnoredScenes(scenes, sceneFailures, "assets");
    if (ignored >= scenes.length) {
      // Task 106-c — TOUTES les scènes définitivement ignorées : échec clair,
      // une vidéo sans aucun visuel n'a pas de sens.
      return {
        action: "terminal-failed",
        message: `Production échouée : les ${scenes.length} scène(s) ont été définitivement ignorées après ${MAX_SCENE_FAILURES} échecs de génération d'image. Vérifiez le moteur de visuels ou réessayez plus tard.`,
      };
    }
    // Task 154 (reprise inter-ticks) — des clips mûrissent ENCORE côté Agnes :
    // l'étape reste ouverte, le tick suivant les finalise (re-sondage des
    // MÊMES tâches — jamais de re-génération) avant de passer à la voix.
    const activeVideoTasks = Object.keys(sceneVideoTasks).length;
    if (activeVideoTasks > 0 || pendingSceneVideos > 0) {
      return {
        action: "stay",
        detail: `${scenes.length} visuel(s) prêt(s) — ${activeVideoTasks} clip(s) vidéo IA en cours de génération côté Agnes (reprise au tick suivant).`,
      };
    }
    return {
      action: "advance",
      detail: `${scenes.length} visuel(s) prêt(s) (${generated} généré(s)${ignored > 0 ? `, ${ignored} scène(s) ignorée(s)` : ""})${narrated > 0 ? ` ; ${narrated} narration(s) générée(s) en parallèle (chevauchement voix-visuels)` : ""}.`,
    };
  }
  return {
    action: "stay",
    detail: pendingSceneVideos > 0
      ? `${job.sceneCursor}/${scenes.length} visuels — clip(s) vidéo IA en cours côté Agnes (reprise au tick suivant).`
      : `${job.sceneCursor}/${scenes.length} visuels traités${narrated > 0 ? ` (+${narrated} narration(s) en parallèle)` : ""}.`,
  };
}

/**
 * VOICE : narrations par lots (MÊME chemin que POST .../generate-voice :
 * enregistrement utilisateur ou TTS ElevenLabs facturé au caractère réel),
 * sceneCursor checkpoint par scène. Aucune voix configurée ou narration
 * désactivée → avancement assumé (vidéo muette — le moteur de rendu la
 * gère explicitement) : une production autopilote ne doit pas mourir faute
 * de profil vocal, l'incident est consigné dans la timeline du job.
 *
 * Task 106-c — TOLÉRANCE PAR SCÈNE : même mécanique que l'étape assets.
 * Task 106-c — IDEMPOTENCE : une scène qui possède DÉJÀ une narration n'est
 * JAMAIS re-synthétisée (les retentes/reprises ne re-facturent pas le TTS).
 *
 * Task 120 — FENÊTRE SUR LE TRAVAIL RÉEL : avec le chevauchement
 * assets∥voice, la plupart des scènes arrivent DÉJÀ narrées à cette étape —
 * elles sont TRAVERSÉES sans consommer le lot (aucun tick perdu en no-op),
 * le lot ne compte que les scènes À narrer réellement. La finalisation
 * (piste voix synchronisée + lit musical) reste le passage obligé ici.
 */
async function stageVoice(job: VideoProductionJob, timeBudgetMs?: number): Promise<ProductionStageResult> {
  const project = await getOwnedProjectOrThrow(job.userId, job.projectId);
  if (!project.script) throw new Error("Scénario absent à l'étape de la voix.");
  const scenes = project.script.scenes;

  if (job.options?.voiceEnabled === false) {
    return { action: "advance", detail: "Narration désactivée — vidéo muette assumée." };
  }
  // FIX A3 : la production autopilote ne produit PLUS de vidéo muette faute
  // de profil vocal — elle narrate avec la VOIX PLATEFORME ElevenLabs (repli
  // du pont TTS, même chemin que le chat). Seule l'option explicite
  // voiceEnabled:false garde la vidéo muette assumée.
  const voice = withPlatformVoiceFallback(await resolvePreferredVoice(job.userId, project));

  // Task 106-c — narrations déjà prêtes (idempotence des reprises : jamais
  // de double synthèse / double facturation lors des retentes par scène).
  const existingNarrations = await listAssets(job.userId, job.projectId, "audio_narration");
  const narratedSceneIds = new Set(existingNarrations.filter((a) => a.sceneId).map((a) => a.sceneId!));

  const deadlineMs = typeof timeBudgetMs === "number" && timeBudgetMs > 0 ? Date.now() + timeBudgetMs : null;
  // Task 106-c — état de tolérance (persisté sur le job à chaque checkpoint).
  let sceneFailures = job.sceneFailures ?? {};
  let warnings = job.warnings ?? [];
  // Task 106-c — détection SYSTÉMIQUE (même contrat que stageAssets).
  let succeededInBatch = 0;
  let fatalInBatch = 0;
  let firstFatalError: unknown = null;
  // Task 106-fix — UN SEUL checkpoint par tick (limite Firestore ~1 écriture/s/doc).
  const cursorAtTickStart = job.sceneCursor;
  const failuresAtTickStart = JSON.stringify(sceneFailures);

  // Task 120 — FENÊTRE : traverse les scènes déjà narrées/ignorées SANS les
  // compter dans le lot ; le lot (≤ ASSET_BATCH_SIZE) ne contient que les
  // scènes À NARRER (reprise du chevauchement assets∥voice ou reprise après
  // incident — narratedSceneIds est le point de vérité idempotent).
  const work: Array<{ scene: ScriptScene; sceneIndex: number }> = [];
  let scan = Math.max(0, Math.min(job.sceneCursor, scenes.length));
  while (scan < scenes.length && work.length < ASSET_BATCH_SIZE) {
    const scene = scenes[scan];
    const alreadyDone =
      narratedSceneIds.has(scene.id) || shouldSkipScene(sceneFailures, sceneFailureKey("voice", scene.id));
    if (!alreadyDone) work.push({ scene, sceneIndex: scan });
    scan += 1;
  }
  // Les scènes traversées déjà prêtes comptent comme du PROGRÈS du lot pour
  // la détection systémique (un no-op y comptait comme réussite avant).
  succeededInBatch += Math.max(0, scan - cursorAtTickStart - work.length);

  let processedAllWork = true;
  for (const { scene, sceneIndex } of work) {
    if (deadlineMs !== null && Date.now() >= deadlineMs) {
      processedAllWork = false;
      break;
    }
    const failureKey = sceneFailureKey("voice", scene.id);
    try {
      const charactersUsed = await narrationTaskForScene(job, scene, voice, narratedSceneIds.has(scene.id));
      if (charactersUsed > 0) {
        await billTts(job.userId, job.projectId, charactersUsed);
      }
      succeededInBatch += 1;
    } catch (error) {
      // Task 106-c — quota/transitoire = incident d'infrastructure : PAS une
      // faute de scène, on remonte au régime de reprise du tick.
      if (classifyTickError(error) !== "fatal") throw error;
      sceneFailures = recordSceneFailure(sceneFailures, failureKey);
      const permanentlyIgnored = shouldSkipScene(sceneFailures, failureKey);
      warnings = appendJobWarning(
        warnings,
        sceneWarningMessage({
          label: "narration",
          sceneNumber: sceneIndex + 1,
          failures: sceneFailures[failureKey],
          permanentlyIgnored,
          cause: error instanceof Error ? error.message : String(error),
        }),
      );
      fatalInBatch += 1;
      if (firstFatalError === null) firstFatalError = error;
    }
    job.sceneCursor = sceneIndex + 1;
  }
  // Curseur : tout le travail examiné est franchi (narrées traversées ou
  // scènes traitées) — l'échéance interrompue laisse le curseur à la
  // dernière scène traitée (reprise au prochain tick).
  if (processedAllWork) {
    job.sceneCursor = Math.max(job.sceneCursor, scan);
  }

  // Task 106-c — SYSTÉMIQUE : aucune narration du lot n'aboutit → régime de
  // reprise du tick (identique à l'étape assets).
  if (fatalInBatch > 0 && succeededInBatch === 0) {
    throw firstFatalError instanceof Error ? firstFatalError : new Error(String(firstFatalError));
  }

  // Task 106-fix — checkpoint CONSOLIDÉ (un par tick) : curseur, progression,
  // tolérance par scène — persistés ensemble.
  if (job.sceneCursor !== cursorAtTickStart || JSON.stringify(sceneFailures) !== failuresAtTickStart) {
    await writeCheckpointSet(
      PRODUCTION_JOBS_COLLECTION,
      job.id,
      {
        sceneCursor: job.sceneCursor,
        progress: computeProductionProgress("voice", job.sceneCursor, scenes.length),
        sceneFailures,
        warnings,
        updatedAt: nowIso(),
      },
      job.userId,
    );
  }

  if (job.sceneCursor < scenes.length) {
    return { action: "stay", detail: `${job.sceneCursor}/${scenes.length} narration(s).` };
  }

  // Fin de lot : retentes des narrations en échec (curseur ramené à la
  // première scène à retenter — les prêtes sont sautées par idempotence).
  const retryIndex = firstSceneNeedingRetry(scenes, sceneFailures, "voice");
  if (retryIndex >= 0 && retryIndex < job.sceneCursor) {
    job.sceneCursor = retryIndex;
    await writeCheckpointSet(
      PRODUCTION_JOBS_COLLECTION,
      job.id,
      { sceneCursor: retryIndex, sceneFailures, warnings, updatedAt: nowIso() },
      job.userId,
    );
    return {
      action: "stay",
      detail: `${job.sceneCursor}/${scenes.length} narrations — scène(s) en échec à reprendre au prochain tick (tolérance par scène).`,
    };
  }

  const ignored = countPermanentlyIgnoredScenes(scenes, sceneFailures, "voice");
  if (ignored >= scenes.length) {
    // Task 113 — « résultat plutôt qu'échec » : TOUTES les narrations ont
    // été définitivement abandonnées (ElevenLabs indisponible, clé/quota,
    // panne réseau) → la production est LIVRÉE EN MUET au lieu d'échouer :
    // les visuels déjà générés (facturés) donnent une vidéo complète et le
    // rendu gère explicitement les scènes sans narration. L'incident reste
    // consigné (warnings + détail d'étape) et le studio permet de relancer
    // la narration à tout moment (generate-voice).
    return {
      action: "advance",
      detail: `Narrations indisponibles (${scenes.length} scène(s) ignorée(s) après ${MAX_SCENE_FAILURES} échecs de synthèse) — vidéo muette livrée ; relancez la narration depuis le studio.`,
    };
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
  return {
    action: "advance",
    detail: `${scenes.length} narration(s) prête(s) (voix : ${voice.name})${ignored > 0 ? `, ${ignored} ignorée(s)` : ""}.`,
  };
}

/** RENDER : enfile le rendu réel (module 19) — il gère sa propre facturation. */
async function stageRender(job: VideoProductionJob): Promise<ProductionStageResult> {
  // Task 113 — PRÉFLIGHT FFmpeg : résout (et met en cache) les binaires
  // AVANT le startRenderJob — un environnement sans FFmpeg (échec du
  // téléchargement runtime épinglé) est détecté ICI avec un message clair,
  // sans réserver le budget rendu ni consommer les relances sur un échec
  // de spawn cryptique. Le cache d'échec est réinitialisé pour que la
  // relance suivante re-tente vraiment le téléchargement (blip réseau).
  const { resolveFfmpegBinary, resolveFfprobeBinary, resetBinaryResolutionCache } = await import("@/lib/video/security");
  const [ffmpeg, ffprobe] = await Promise.all([resolveFfmpegBinary(), resolveFfprobeBinary()]);
  const diagnostics = [ffmpeg, ffprobe]
    .map((b, i) => (b.diagnostic ? `${i === 0 ? "ffmpeg" : "ffprobe"} : ${b.diagnostic}` : null))
    .filter((d): d is string => typeof d === "string");
  if (diagnostics.length > 0) {
    resetBinaryResolutionCache();
    throw new Error(`Moteur de rendu indisponible sur cette plateforme (${diagnostics.join(" ; ")}) — le rendu sera retenté automatiquement ; aucune facturation tant qu'aucun rendu ne démarre.`);
  }
  const project = await getOwnedProjectOrThrow(job.userId, job.projectId);
  // Task 134 — PRÉPARATION TIMELINE AVANT RENDU : les options de création
  // (sous-titres on/off + style + position, ambiance d'effets) sont
  // appliquées sur la timeline AVANT startRenderJob. La timeline est
  // matérialisée si nécessaire (ensureProjectTimeline, idempotent) — sinon
  // un projet jamais ouvert dans l'atelier ne recevrait jamais les choix
  // exprimés dans la demande (le bootstrap du rendu repart du scénario).
  const wantsSubtitleTuning = Boolean(
    job.options?.subtitleStyle || job.options?.subtitlePosition || job.options?.subtitlesEnabled === false,
  );
  const wantsEffectPreset = Boolean(job.options?.effectPreset && job.options.effectPreset !== "none");
  if (wantsSubtitleTuning || wantsEffectPreset) {
    const { ensureProjectTimeline } = await import("@/lib/video/timeline-bootstrap");
    const ensured = await ensureProjectTimeline(job.userId, job.projectId);
    let timeline = ensured.timeline;
    // 1) Sous-titres : coupure ET style/position demandés à la création.
    const captionsPatch: Partial<VideoTimeline["captions"]> = {};
    if (job.options?.subtitlesEnabled === false) captionsPatch.enabled = false;
    if (job.options?.subtitleStyle) captionsPatch.style = job.options.subtitleStyle;
    if (job.options?.subtitlePosition) captionsPatch.position = job.options.subtitlePosition;
    if (Object.keys(captionsPatch).length > 0) {
      timeline = { ...timeline, captions: { ...timeline.captions, ...captionsPatch } };
    }
    // 2) Effets d'animation : le preset est FUSIONNÉ dans chaque clip image
    // (les effets choisis par le scénario restent maîtres — merge sans
    // doublon) + motion recommandée pour les clips sans mouvement explicite.
    const preset = parseEffectPreset(job.options?.effectPreset);
    if (preset && preset !== "none") {
      const motionPreset = PRESET_MOTION[preset];
      timeline = {
        ...timeline,
        tracks: timeline.tracks.map((track) =>
          track.kind !== "image"
            ? track
            : {
                ...track,
                clips: track.clips.map((clip) => ({
                  ...clip,
                  effects: mergePresetEffects(clip.effects ?? [], preset),
                  ...(!clip.motion && motionPreset ? { motion: buildMotion(motionPreset, clip.durationSec) } : {}),
                })),
              },
        ),
      };
    }
    await patchProject(job.userId, job.projectId, { timeline });
  }
  // Option subtitlesEnabled:false → sous-titres coupés sur la timeline.
  if (job.options?.subtitlesEnabled === false && project.timeline?.captions?.enabled && !wantsSubtitleTuning) {
    await patchProject(job.userId, job.projectId, {
      timeline: { ...project.timeline, captions: { ...project.timeline.captions, enabled: false } },
    });
  }
  const derivedTargets = job.options?.derivedTargets
    ? RenderRequestSchema.parse({ derivedTargets: job.options.derivedTargets }).derivedTargets
    : [];
  // Task 119 — CONTRAT UTILISATEUR porté par le job de rendu : la volonté
  // explicite de l'utilisateur (durée demandée, narration, sous-titres) est
  // vérifiée par la QC sur le master réellement livré (±10 %, flux voix,
  // sous-titres brûlés). Un rendu lancé hors production autopilote ne porte
  // AUCUN contrat (startRenderJob appelé sans ce champ).
  const render = await startRenderJob({
    userId: job.userId,
    projectId: job.projectId,
    derivedTargets,
    contract: {
      targetDurationSec: project.targetDurationSec,
      narrationRequired: job.options?.voiceEnabled !== false,
      captionsRequired: job.options?.subtitlesEnabled !== false && Boolean(project.timeline?.captions?.enabled),
    },
  });
  // Rattaché AVANT le passage à l'étape done (visible même si le tick meurt ici).
  // Task 95-d — écriture via la couche résiliente (Firestore unique moteur, Task 108).
  await writeCheckpointSet(PRODUCTION_JOBS_COLLECTION, job.id, { renderJobId: render.jobId, updatedAt: nowIso() }, job.userId);
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

// Les étapes sont exportées pour le dispatcher de ticks (production-queue).
export {
  stageProject,
  stagePlan,
  stageScript,
  stageAssets,
  stageVoice,
  stageRender,
  stageDone,
};
