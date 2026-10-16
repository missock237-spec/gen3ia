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
} from "@/lib/ai/video-generation";
import { registerAsset, listAssets } from "@/lib/video/asset-service";
import { adminDb } from "@/lib/firebase/admin";
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
// ────────────────────────────────────────────────────────────────────────────

/** Vocabulaire cinéma professionnel par preset de mouvement (EN — standard industriel). */
const CAMERA_LANGUAGE: Record<ScriptScene["cameraMotion"], string> = {
  static: "locked-off static shot on a heavy tripod, perfectly stable framing",
  slow_zoom: "slow, smooth camera push-in (dolly in) with gentle easing, no jitter",
  zoom_out: "slow camera pull-back (dolly out) progressively revealing the environment",
  ken_burns: "gentle cinematic pan combined with a slow zoom, classic Ken Burns drift",
  pan_left_right: "smooth lateral tracking pan from left to right, gimbal-stabilized",
  pan_right_left: "smooth lateral tracking pan from right to left, gimbal-stabilized",
  tilt_up: "slow tilt-up reveal moving from the lower part of the frame to the top",
  tilt_down: "slow tilt-down reveal moving from the top of the frame to the bottom",
  parallax: "subtle parallax camera drift conveying depth between foreground and background",
  dramatic_push: "dramatic dolly push-in with slight acceleration building tension",
};

const PROFESSIONAL_STYLE_BLOCK = [
  "photorealistic cinematic footage",
  "professional film lighting with motivated practical sources",
  "shallow depth of field, creamy bokeh",
  "natural motion blur",
  "high dynamic range, rich yet natural skin tones",
  "professional color grading",
  "high detail, realistic textures and materials",
].join(", ");

const CONSISTENCY_BLOCK = [
  "strictly preserve the exact appearance, proportions, clothing and environment shown in the first frame",
  "keep identity of every character stable throughout, no morphing, no warping faces or hands",
  "no text overlays, no watermark, no subtitles, no logo",
  "plausible physics, no impossible movements",
].join("; ");

/**
 * Construit le prompt cinéma d'une scène : le visualPrompt du scénario
 * (sujet/cadre) + narration comme indication d'action + caméra + style +
 * cohérence. Bilingue par nature : le scénario reste dans sa langue, le
 * vocabulaire technique caméra/style est en anglais (standard modèle).
 */
export function buildSceneMotionPrompt(project: VideoProject, scene: ScriptScene): string {
  const composed = composeScenePrompt(project, scene);
  const camera = CAMERA_LANGUAGE[scene.cameraMotion] ?? CAMERA_LANGUAGE.static;
  const narrationHint = scene.narration.trim().slice(0, 240);
  const sound = scene.soundEffects.length > 0
    ? `subtle, realistic ambient sound matching: ${scene.soundEffects.join(", ")}`
    : "subtle, realistic ambient sound of the environment";

  const blocks = [
    `Subject and setting: ${composed.prompt}`,
    narrationHint ? `On-screen moment: ${narrationHint}` : "",
    `Camera: ${camera}`,
    `Visual style: ${PROFESSIONAL_STYLE_BLOCK}${project.style ? `, overall tone: ${project.style}` : ""}`,
    `Sound: ${sound}`,
    `Consistency: ${CONSISTENCY_BLOCK}`,
  ].filter(Boolean);
  return blocks.join(". ").slice(0, 3500);
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

/** Budget de clips IA par projet (plafond strict, spec §28). */
async function assertSceneVideoBudget(userId: string, projectId: string): Promise<void> {
  const snap = await adminDb.collection("videoAssets").where("userId", "==", userId).get();
  const count = snap.docs.filter((d) => {
    const data = d.data();
    return data?.projectId === projectId && data?.kind === "video" && data?.origin === "generated";
  }).length;
  if (count >= VIDEO_LIMITS.maxGeneratedSceneVideos) {
    throw new VideoQuotaError(
      `Plafond de ${VIDEO_LIMITS.maxGeneratedSceneVideos} clips vidéo IA atteint pour ce projet.`,
    );
  }
}

/**
 * Génère (ou réutilise) le clip vidéo IA d'une scène :
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

  // 2) URL publique signée de la first frame (valide pendant toute la tâche).
  const firstFrameUrl = await createVideoPlaybackUrl(userId, image.r2Key, 3600);

  // 3) Prompt cinéma + paramètres.
  const prompt = buildSceneMotionPrompt(project, scene);
  const clipSeconds = clipSecondsForScene(scene);
  const size = videoSizeForResolution(project.resolution);
  const externalCostEur = agnesVideoCostEur(clipSeconds, size);

  // 4) Réservation du coût AVANT la génération (402 si solde insuffisant).
  const reservation = await reserveSceneVideoBilling({
    userId,
    projectId: project.id,
    sceneId: scene.id,
    seconds: clipSeconds,
    externalCostEur,
  });

  let generated;
  try {
    generated = await generateVideo({
      prompt,
      mode: "keyframe",
      firstFrameUrl,
      seconds: clipSeconds,
      size,
      aspectRatio: videoAspectRatioFor(project.aspectRatio),
    });
  } catch (error) {
    // Échec → RIEN n'est débité (libération intégrale de la réservation).
    await releaseReservation({ userId, reference: reservation.reference, reservedMinor: reservation.reserveMinor })
      .catch(() => undefined);
    if (isVideoUnavailableError(error)) {
      throw new SceneVideoUnavailableError(
        error instanceof Error ? error.message : "Génération vidéo IA indisponible.",
      );
    }
    throw error;
  }

  // 5) Téléchargement du MP4 + enregistrement comme asset projet (ffprobe).
  let asset: VideoAsset;
  try {
    const response = await fetch(generated.videoUrl, { signal: AbortSignal.timeout(120_000) });
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
    // Le clip est généré et facturé chez le fournisseur : on règle la
    // réservation (le coût a bien été engagé) puis on remonte l'erreur
    // d'enregistrement — pas de livraison, mais pas de vol non plus.
    await settleReservation({
      userId,
      reference: reservation.reference,
      reservedMinor: reservation.reserveMinor,
      actualChargeMinor: reservation.chargeMinor,
    }).catch(() => undefined);
    throw error;
  }

  // 6) Règlement au réel (durée de sortie réelle si connue, sinon demandée).
  const actualSeconds = generated.seconds > 0 ? generated.seconds : clipSeconds;
  const actualExternalEur = agnesVideoCostEur(actualSeconds, size);
  const actual = estimateExecutionCost({ task: "automation", complexity: 1, externalToolCostEur: actualExternalEur, toolCalls: 1 });
  const settleMinor = Math.min(actual.chargeMinor, reservation.reserveMinor); // jamais au-delà du réservé
  await settleReservation({
    userId,
    reference: reservation.reference,
    reservedMinor: reservation.reserveMinor,
    actualChargeMinor: settleMinor,
    metadata: {
      kind: "video_generation",
      provider: "agnes",
      projectId: project.id,
      sceneId: scene.id,
      seconds: String(actualSeconds),
      size,
      model: generated.model,
    },
  }).catch(() => undefined); // fail-soft : la vidéo est livrée, le règlement est journalisé

  return {
    sceneId: scene.id,
    assetId: asset.id,
    generated: true,
    reused: false,
    clipSeconds: actualSeconds,
    latencyMs: generated.latencyMs,
    chargeMinor: settleMinor,
    providerCostEur: actualExternalEur,
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
