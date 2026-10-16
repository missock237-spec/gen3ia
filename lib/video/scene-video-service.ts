import "server-only";

/**
 * GEN3IA VIDEO AGENT — Task 154 : VRAIS clips vidéo IA par scène.
 *
 * Le pipeline historique anime des images fixes (zoompan FFmpeg « Ken
 * Burns »). Ce service produit désormais, pour chaque scène, un CLIP
 * VIDÉO GÉNÉRÉ PAR IA (Agnes Video 2.5) :
 *
 *   1. l'image cohérente de la scène (Consistency Engine, inchangé) devient
 *      la FIRST FRAME du clip (mode keyframe) → les personnages ne changent
 *      pas d'apparence entre les scènes, image ET vidéo ;
 *   2. un prompt CINÉMA structuré (sujet → action → caméra → style → son →
 *      cohérence) pilote le mouvement réaliste (dolly, tracking, parallax) ;
 *   3. facturation portefeuille AVANT génération (réservation pire cas),
 *      règlement au réel, libération intégrale sur échec (philosophie
 *      escrow Task 153) ;
 *   4. repli automatique : Agnes Video indisponible (clé, 5xx, timeout) →
 *      la scène reste en animation image Ken Burns (le rendu aboutit).
 *
 * Les clips sont stockés comme assets (kind "video", rôle
 * « scene-video:<sceneId> ») et consommés par le planner de rendu
 * (videoR2Keys) qui remplace le zoompan par le clip réel.
 */

import { randomUUID } from "node:crypto";
import type { ScriptScene, VideoAsset, VideoProject } from "@/lib/video/types";
import { VIDEO_LIMITS, VideoQuotaError } from "@/lib/video/security";
import {
  generateSceneImage,
  findSceneImage,
} from "@/lib/video/image-bridge";
import {
  generateVideo,
  isVideoGenerationEnabled,
  areSceneClipsEnabled,
  videoSizeForResolution,
  videoAspectRatioFor,
  agnesVideoCostEur,
  MAX_CLIP_SECONDS,
  MIN_CLIP_SECONDS,
  isVideoUnavailableError,
  awaitVideoTask,
  createVideoTask,
  type VideoSize,
} from "@/lib/ai/video-generation";
import { registerAsset, listAssets, countGeneratedProjectAssets } from "@/lib/video/asset-service";
import { createVideoPlaybackUrl } from "@/lib/video/storage";
import { estimateExecutionCost } from "@/lib/billing/cost-engine";
import { reserveFunds, settleReservation, releaseReservation } from "@/lib/billing/wallet";
import { mapWithConcurrency } from "@/lib/video/concurrency";
import { composeScenePrompt } from "@/lib/video/consistency-engine";

/** Rôle d'un clip vidéo de scène dans la Media Library. */
export function sceneVideoRole(sceneId: string): string {
  return `scene-video:${sceneId}`;
}

/** Clip vidéo IA déjà généré pour la scène (idempotence / révisions). */
export async function findSceneVideo(userId: string, projectId: string, sceneId: string): Promise<VideoAsset | null> {
  const videos = await listAssets(userId, projectId, "video");
  return videos.find((a) => a.sceneId === sceneId && a.role === sceneVideoRole(sceneId)) ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt cinéma — structure recommandée Agnes Video (doc officielle) :
// 1 sujet/cadre → 2 action/évolution → 3 langage caméra → 4 style visuel →
// 5 son/rythme → 6 exigences de cohérence.
// Task 158 — recherche industrie 2026 (guides prompts Veo 3 / Kling 3 /
// Runway + doc Agnes) : le réalisme perçu provient de (a) un ancrage du
// mouvement À PARTIR de la première frame (mode keyframe), (b) du vocabulaire
// d'optique/éclairage de chef opérateur, (c) d'exigences de physique et de
// stabilité temporelle explicites — cibles n°1 des artefacts « vidéo IA ».
// ────────────────────────────────────────────────────────────────────────────

/** Vocabulaire cinéma professionnel par preset de mouvement (EN — standard industriel). */
const CAMERA_LANGUAGE: Record<ScriptScene["cameraMotion"], string> = {
  static: "locked-off static shot on a heavy tripod, perfectly stable framing, only the subject and environment move naturally inside the frame",
  slow_zoom: "slow, smooth camera push-in (dolly in) with gentle easing, no jitter, fluid gear-driven motion",
  zoom_out: "slow camera pull-back (dolly out) progressively revealing the environment, steady rails-mounted motion",
  ken_burns: "gentle cinematic pan combined with a slow zoom, classic Ken Burns drift, steady and perfectly controlled",
  pan_left_right: "smooth lateral tracking pan from left to right, gimbal-stabilized, constant speed",
  pan_right_left: "smooth lateral tracking pan from right to left, gimbal-stabilized, constant speed",
  tilt_up: "slow tilt-up reveal moving from the lower part of the frame to the top, controlled crane-like motion",
  tilt_down: "slow tilt-down reveal moving from the top of the frame to the bottom, controlled crane-like motion",
  parallax: "subtle parallax camera drift conveying depth between foreground and background, slow dolly on a camera slider",
  dramatic_push: "dramatic dolly push-in with slight acceleration building tension, deliberate cinematic urgency",
};

const PROFESSIONAL_STYLE_BLOCK = [
  "photorealistic cinematic footage, indistinguishable from real camera capture",
  "shot on a full-frame cinema camera with high-end prime lenses",
  "professional three-point film lighting with motivated practical sources",
  "natural volumetric light, soft ambient occlusion",
  "shallow depth of field, creamy bokeh with smooth focus falloff",
  "natural motion blur following the 180-degree shutter rule",
  "high dynamic range, rich yet natural skin tones, true-to-life colors",
  "professional color grading, subtle film grain, gentle highlight roll-off",
  "ultra-detailed micro-textures — skin pores, fabric weave, surface imperfections",
  "physically accurate reflections and shadows, realistic atmospheric depth",
].join(", ");

/**
 * Task 158 — physique du mouvement & stabilité temporelle : le mode keyframe
 * doit ancrer l'action DANS la pose de la première frame (exemple officiel
 * Agnes : « The person turns naturally from the first-frame pose… ») et les
 * artefacts IA (métamorphose, scintillement, anatomie) sont contrés
 * explicitement — ce sont les trois premiers marqueurs de « fausse vidéo ».
 */
const MOTION_PHYSICS_BLOCK = [
  "movement starts naturally from the exact pose, composition and lighting of the first frame, then unfolds continuously",
  "realistic body mechanics with natural weight, momentum and follow-through in every gesture",
  "anatomically correct humans and animals, natural hand and finger articulation",
  "temporally stable: consistent faces, clothing and lighting from frame to frame, no flicker, no warping, no melting textures",
].join("; ");

const CONSISTENCY_BLOCK = [
  "strictly preserve the exact appearance, proportions, clothing and environment shown in the first frame",
  "keep identity of every character stable throughout, no morphing, no warping faces or hands",
  "no text overlays, no watermark, no subtitles, no logo",
  "plausible physics, no impossible movements",
].join("; ");

/**
 * Graine déterministe par scène (FNV-1a 32 bits) : la ré-génération d'une
 * même scène (révision, retry) part de la même base aléatoire côté Agnes —
 * reproductibilité du rendu, doc : « Reusing a seed can improve
 * reproducibility ».
 */
export function sceneSeed(sceneId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sceneId.length; i++) {
    hash ^= sceneId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const seed = Math.abs(hash | 0);
  return seed === 0 ? 1 : seed;
}

/**
 * Construit le prompt cinéma d'une scène : le visualPrompt du scénario
 * (sujet/cadre) + narration comme indication d'action + ancrage mouvement
 * première frame + caméra + style + son + cohérence. Bilingue par nature :
 * le scénario reste dans sa langue, le vocabulaire technique caméra/style
 * est en anglais (standard modèle).
 *
 * Budget de caractères : les blocs REALISME (mouvement, caméra, style, son,
 * cohérence) sont TOUJOURS retenus intégralement — seul le bloc sujet
 * absorbe la réduction, avec un plancher garanti de 600 caractères (bug
 * latent corrigé : le slice final pouvait tronquer la cohérence).
 */
export function buildSceneMotionPrompt(project: VideoProject, scene: ScriptScene): string {
  const composed = composeScenePrompt(project, scene);
  const camera = CAMERA_LANGUAGE[scene.cameraMotion] ?? CAMERA_LANGUAGE.static;
  const narrationHint = scene.narration.trim().slice(0, 240);
  const sound = scene.soundEffects.length > 0
    ? `subtle, realistic ambient sound matching: ${scene.soundEffects.join(", ")}`
    : "subtle, realistic ambient sound of the environment";

  const fixedBlocks = [
    narrationHint ? `On-screen moment: ${narrationHint}` : "",
    `Motion: ${MOTION_PHYSICS_BLOCK}`,
    `Camera: ${camera}`,
    `Visual style: ${PROFESSIONAL_STYLE_BLOCK}${project.style ? `, overall tone: ${project.style}` : ""}`,
    `Sound: ${sound}`,
    `Consistency: ${CONSISTENCY_BLOCK}`,
  ].filter(Boolean);
  const fixedText = fixedBlocks.join(". ");

  const subjectBudget = Math.max(600, 3480 - fixedText.length);
  const subject = `Subject and setting: ${composed.prompt.slice(0, subjectBudget)}`;
  return [subject, fixedText].join(". ");
}

/** Durée du clip à générer pour couvrir la scène (bornes API 4–12 s). */
export function clipSecondsForScene(scene: ScriptScene): number {
  return Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, Math.ceil(scene.durationSec)));
}

// ────────────────────────────────────────────────────────────────────────────
// Facturation — réservation AVANT génération, règlement au réel, libération
// sur échec (même mécanique que le portillon d'exécution Task 153).
// ────────────────────────────────────────────────────────────────────────────

export class SceneVideoUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneVideoUnavailableError";
  }
}

interface BillingReservation {
  reference: string;
  reserveMinor: number;
  chargeMinor: number;
}

/**
 * Réserve le pire coût d'un clip (durée demandée × tarif du palier, avec
 * overhead + marge plateforme + multiplicateur de réserve). Renvoie la
 * réservation à régler/libérer. 402 (fonds insuffisants) remonté tel quel.
 */
async function reserveSceneVideoBilling(params: {
  userId: string;
  projectId: string;
  sceneId: string;
  seconds: number;
  externalCostEur: number;
}): Promise<BillingReservation> {
  const estimate = estimateExecutionCost({
    task: "automation",
    complexity: 1,
    externalToolCostEur: params.externalCostEur,
    toolCalls: 1,
  });
  const reference = `scenevideo_${params.projectId.slice(0, 12)}_${params.sceneId.slice(0, 12)}_${randomUUID()}`;
  await reserveFunds({
    userId: params.userId,
    amountMinor: estimate.reserveMinor,
    reference,
    metadata: {
      kind: "video_generation",
      provider: "agnes",
      projectId: params.projectId,
      sceneId: params.sceneId,
      seconds: String(params.seconds),
    },
  });
  return { reference, reserveMinor: estimate.reserveMinor, chargeMinor: estimate.chargeMinor };
}

// ────────────────────────────────────────────────────────────────────────────
// Génération d'un clip de scène
// ────────────────────────────────────────────────────────────────────────────

export interface SceneVideoResult {
  sceneId: string;
  assetId: string;
  generated: boolean;
  reused: boolean;
  clipSeconds: number;
  latencyMs: number;
  chargeMinor: number;
  providerCostEur: number;
}

/**
 * Tâche vidéo VIVANTE d'une scène — sérialisée sur le job de production
 * (reprise INTER-TICKS) : la génération mûrit côté Agnes, le tick suivant
 * RE-SONDE la même tâche au lieu de re-générer (idempotence économique :
 * jamais deux coûts fournisseur pour une même scène).
 */
export interface SceneVideoTaskState {
  videoId: string;
  taskId: string;
  /** Référence de réservation wallet OUVERTE (à régler/libérer à la terminaison). */
  billingReference: string;
  reserveMinor: number;
  chargeMinor: number;
  seconds: number;
  size: string;
  startedAt: string;
}

/**
 * DÉMARRAGE du clip d'une scène : image (first frame) + réservation wallet
 * + création de tâche Agnes (PAS de sondage). Retourne l'état SÉRIALISABLE
 * à persister IMMÉDIATEMENT sur le job (survie aux crashes) — l'appelant
 * sonde ensuite via awaitSceneVideoTask avec SON budget de tick.
 */
export async function startSceneVideoTask(params: {
  userId: string;
  project: VideoProject;
  scene: ScriptScene;
  /** Image de scène déjà résolue par l'appelant (vague assets). */
  image: VideoAsset;
}): Promise<SceneVideoTaskState> {
  const { userId, project, scene } = params;
  if (!isSceneVideoServiceEnabled()) {
    throw new SceneVideoUnavailableError("Génération de clips vidéo IA désactivée sur cette plateforme.");
  }
  await assertSceneVideoBudget(userId, project.id);

  const prompt = buildSceneMotionPrompt(project, scene);
  const clipSeconds = clipSecondsForScene(scene);
  const size = videoSizeForResolution(project.resolution);
  const externalCostEur = agnesVideoCostEur(clipSeconds, size);

  const reservation = await reserveSceneVideoBilling({
    userId,
    projectId: project.id,
    sceneId: scene.id,
    seconds: clipSeconds,
    externalCostEur,
  });

  let created: { videoId: string; taskId: string; status: string };
  try {
    const firstFrameUrl = await createVideoPlaybackUrl(userId, params.image.r2Key, 3600);
    created = await createVideoTask({
      prompt,
      mode: "keyframe",
      firstFrameUrl,
      seconds: clipSeconds,
      size,
      aspectRatio: videoAspectRatioFor(project.aspectRatio),
      seed: sceneSeed(scene.id),
    });
  } catch (error) {
    // Échec au démarrage → RIEN n'est débité (libération intégrale).
    await releaseReservation({ userId, reference: reservation.reference, reservedMinor: reservation.reserveMinor })
      .catch(() => undefined);
    if (isVideoUnavailableError(error)) {
      throw new SceneVideoUnavailableError(error instanceof Error ? error.message : "Génération vidéo IA indisponible.");
    }
    throw error;
  }

  return {
    videoId: created.videoId,
    taskId: created.taskId,
    billingReference: reservation.reference,
    reserveMinor: reservation.reserveMinor,
    chargeMinor: reservation.chargeMinor,
    seconds: clipSeconds,
    size,
    startedAt: new Date().toISOString(),
  };
}

/** Résultat du re-sondage d'une tâche vivante. */
export type AwaitSceneVideoOutcome =
  | { status: "completed"; assetId: string; clipSeconds: number; chargeMinor: number; providerCostEur: number }
  /** Échéance atteinte SANS terminaison : la tâche vit toujours côté Agnes —
   * reprise au tick suivant (état à CONSERVER tel quel sur le job). */
  | { status: "pending" }
  | { status: "failed"; error: string; unavailable: boolean };

/**
 * FINALISATION d'une tâche vivante : re-sondage borné par l'échéance de
 * l'appelant (budget du tick), téléchargement + enregistrement + règlement
 * au réel. Idempotence : un clip DÉJÀ enregistré (crash entre register et
 * checkpoint du tick précédent) → rattrapage du règlement et completed.
 */
export async function awaitSceneVideoTask(params: {
  userId: string;
  project: VideoProject;
  scene: ScriptScene;
  task: SceneVideoTaskState;
  /** Échéance absolue (Date.now()) du sondage ; défaut = timeout du client. */
  deadlineMs?: number;
}): Promise<AwaitSceneVideoOutcome> {
  const { userId, project, scene, task } = params;

  // Rattrapage idempotent : finalisé par un tick précédent mort avant checkpoint.
  const alreadyRegistered = await findSceneVideo(userId, project.id, scene.id);
  if (alreadyRegistered) {
    await settleReservation({
      userId,
      reference: task.billingReference,
      reservedMinor: task.reserveMinor,
      actualChargeMinor: Math.min(task.chargeMinor, task.reserveMinor),
    }).catch(() => undefined);
    return { status: "completed", assetId: alreadyRegistered.id, clipSeconds: alreadyRegistered.media?.durationSec ?? task.seconds, chargeMinor: 0, providerCostEur: 0 };
  }

  const polled = await awaitVideoTask({ videoId: task.videoId, deadlineMs: params.deadlineMs });
  if (polled.status === "pending") {
    return { status: "pending" };
  }
  if (polled.status === "failed") {
    // Échec définitif côté Agnes → libération intégrale (rien n'est débité).
    await releaseReservation({ userId, reference: task.billingReference, reservedMinor: task.reserveMinor })
      .catch(() => undefined);
    return { status: "failed", error: polled.error ?? "Génération vidéo échouée côté Agnes.", unavailable: true };
  }

  // completed → téléchargement + enregistrement + règlement au réel.
  let asset: VideoAsset;
  try {
    const response = await fetch(polled.videoUrl!, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Téléchargement du clip : HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "video/mp4";
    if (!/^video\//.test(contentType)) throw new Error("Le contenu téléchargé n'est pas une vidéo.");
    const body = Buffer.from(await response.arrayBuffer());
    asset = await registerAsset({
      userId,
      projectId: project.id,
      kind: "video",
      label: `Clip IA ${scene.id}`,
      role: sceneVideoRole(scene.id),
      sceneId: scene.id,
      origin: "generated",
      contentType,
      body,
    });
  } catch (error) {
    // Coût engagé chez le fournisseur : règlement de la réservation puis
    // remontée de l'erreur d'enregistrement (pas de livraison, pas de vol).
    await settleReservation({
      userId,
      reference: task.billingReference,
      reservedMinor: task.reserveMinor,
      actualChargeMinor: task.chargeMinor,
    }).catch(() => undefined);
    return { status: "failed", error: error instanceof Error ? error.message : String(error), unavailable: false };
  }

  const actualSeconds = polled.seconds && polled.seconds > 0 ? polled.seconds : task.seconds;
  const actualExternalEur = agnesVideoCostEur(actualSeconds, task.size as VideoSize);
  const actual = estimateExecutionCost({ task: "automation", complexity: 1, externalToolCostEur: actualExternalEur, toolCalls: 1 });
  const settleMinor = Math.min(actual.chargeMinor, task.reserveMinor);
  await settleReservation({
    userId,
    reference: task.billingReference,
    reservedMinor: task.reserveMinor,
    actualChargeMinor: settleMinor,
    metadata: {
      kind: "video_generation",
      provider: "agnes",
      projectId: project.id,
      sceneId: scene.id,
      seconds: String(actualSeconds),
      size: task.size,
      model: "agnes-video-2.5",
    },
  }).catch(() => undefined); // fail-soft : la vidéo est livrée, le règlement est journalisé

  return { status: "completed", assetId: asset.id, clipSeconds: actualSeconds, chargeMinor: settleMinor, providerCostEur: actualExternalEur };
}

export interface GenerateSceneVideoParams {
  userId: string;
  project: VideoProject;
  scene: ScriptScene;
  /** Force la régénération même si un clip existe. */
  force?: boolean;
}

/** Vrai si le service de clips IA est actif (clé + levier métier). */
export function isSceneVideoServiceEnabled(): boolean {
  return isVideoGenerationEnabled() && areSceneClipsEnabled();
}

/** Budget de clips IA par projet (plafond strict, spec §28) — Task 159 :
 * lecture d'index SEULE (1 doc), plus AUCUN scan de collection. */
async function assertSceneVideoBudget(userId: string, projectId: string): Promise<void> {
  const count = await countGeneratedProjectAssets(userId, projectId, "video");
  if (count >= VIDEO_LIMITS.maxGeneratedSceneVideos) {
    throw new VideoQuotaError(
      `Plafond de ${VIDEO_LIMITS.maxGeneratedSceneVideos} clips vidéo IA atteint pour ce projet.`,
    );
  }
}

/**
 * Génère (ou réutilise) le clip vidéo IA d'une scène — orchestration complète
 * (démarrage + sondage à fond de budget) pour les appels DIRECTS (route
 * generate-videos, tests). La file de production utilise les deux moitiés
 * séparément (startSceneVideoTask + awaitSceneVideoTask) pour reprendre les
 * tâches vivantes entre les ticks sans jamais re-générer.
 * - un clip déjà lié à la scène → réutilisé (idempotence, révisions) ;
 * - l'image cohérente de la scène devient la FIRST FRAME du clip ;
 * - facturation : réservation avant, règlement au réel après ;
 * - Agnes Video indisponible → SceneVideoUnavailableError (repli Ken Burns).
 */
export async function generateSceneVideo(params: GenerateSceneVideoParams): Promise<SceneVideoResult> {
  const { userId, project, scene } = params;
  if (!isSceneVideoServiceEnabled()) {
    throw new SceneVideoUnavailableError("Génération de clips vidéo IA désactivée sur cette plateforme.");
  }

  const existing = await findSceneVideo(userId, project.id, scene.id);
  if (existing && !params.force) {
    return {
      sceneId: scene.id,
      assetId: existing.id,
      generated: false,
      reused: true,
      clipSeconds: existing.media?.durationSec ?? 0,
      latencyMs: 0,
      chargeMinor: 0,
      providerCostEur: 0,
    };
  }

  await assertSceneVideoBudget(userId, project.id);

  // 1) L'image cohérente de la scène (générée si absente — Consistency Engine).
  let image = await findSceneImage(userId, project.id, scene.id);
  if (!image) {
    await generateSceneImage({ userId, project, scene });
    image = await findSceneImage(userId, project.id, scene.id);
  }
  if (!image) {
    throw new SceneVideoUnavailableError(`Image de la scène ${scene.id} indisponible pour animer le clip.`);
  }

  // 2) Démarrage + sondage complet (client Agnes, timeout configurable).
  const startedAt = Date.now();
  const task = await startSceneVideoTask({ userId, project, scene, image });
  const outcome = await awaitSceneVideoTask({ userId, project, scene, task });
  if (outcome.status === "pending") {
    // Ne devrait pas arriver (deadline illimitée par défaut) — traité en
    // indisponibilité pour l'appelant direct, la réservation est libérée.
    await releaseReservation({ userId, reference: task.billingReference, reservedMinor: task.reserveMinor }).catch(() => undefined);
    throw new SceneVideoUnavailableError("Clip vidéo IA : délai d'attente dépassé.");
  }
  if (outcome.status === "failed") {
    if (outcome.unavailable) {
      throw new SceneVideoUnavailableError(outcome.error);
    }
    throw new Error(outcome.error);
  }

  return {
    sceneId: scene.id,
    assetId: outcome.assetId,
    generated: true,
    reused: false,
    clipSeconds: outcome.clipSeconds,
    latencyMs: Date.now() - startedAt,
    chargeMinor: outcome.chargeMinor,
    providerCostEur: outcome.providerCostEur,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Génération en lot — vague de sous-agents parallèles (Task 134), une scène
// en échec n'interrompt jamais le lot.
// ────────────────────────────────────────────────────────────────────────────

export interface SceneVideoBatchResult {
  generated: number;
  reused: number;
  failed: number;
  degraded: number;
  totalChargeMinor: number;
  results: Array<{
    sceneId: string;
    status: "generated" | "reused" | "failed" | "degraded";
    assetId?: string;
    error?: string;
    chargeMinor?: number;
  }>;
}

export async function generateAllSceneVideos(params: {
  userId: string;
  project: VideoProject;
  sceneIds?: string[];
  force?: boolean;
  /** Concurrence bornée (défaut : limite parallèle assets du projet). */
  concurrency?: number;
  onScene?: (result: SceneVideoBatchResult["results"][number]) => void;
}): Promise<SceneVideoBatchResult> {
  const scenes = params.sceneIds
    ? params.project.script!.scenes.filter((s) => params.sceneIds!.includes(s.id))
    : params.project.script?.scenes ?? [];

  const limit = Math.max(
    1,
    Math.min(
      params.concurrency ?? VIDEO_LIMITS.maxParallelAssetGenerations,
      Math.max(1, scenes.length),
    ),
  );

  const outcomes = await mapWithConcurrency(
    scenes,
    limit,
    async (scene): Promise<SceneVideoBatchResult["results"][number]> => {
      try {
        const result = await generateSceneVideo({
          userId: params.userId,
          project: params.project,
          scene,
          force: params.force,
        });
        const entry: SceneVideoBatchResult["results"][number] = result.reused
          ? { sceneId: scene.id, status: "reused", assetId: result.assetId }
          : { sceneId: scene.id, status: "generated", assetId: result.assetId, chargeMinor: result.chargeMinor };
        params.onScene?.(entry);
        return entry;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        params.onScene?.({ sceneId: scene.id, status: "failed", error: message });
        return { sceneId: scene.id, status: "failed", error: message };
      }
    },
  );

  // Association scène ↔ résultat préservée MÊME en cas de rejet/skip du pool
  // (les résultats sont dans l'ordre des entrées — contrat mapWithConcurrency).
  const results = outcomes.map((outcome, index) => {
    const scene = scenes[index];
    if (outcome.status === "fulfilled") return outcome.value;
    return {
      sceneId: scene.id,
      status: "failed" as const,
      error: outcome.status === "rejected" ? String(outcome.reason) : "non démarré (budget temps)",
    };
  });
  // Les rejets du pool (imprévus) sont rares : on ne perd pas la scène.
  const generated = results.filter((r) => r.status === "generated").length;
  const reused = results.filter((r) => r.status === "reused").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const totalChargeMinor = results.reduce((sum, r) => sum + (r.chargeMinor ?? 0), 0);
  return { generated, reused, failed, degraded: 0, totalChargeMinor, results };
}
