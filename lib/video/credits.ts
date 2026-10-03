import "server-only";

/**
 * GEN3IA VIDEO AGENT — facturation par ressources consommées (spec §29).
 *
 * PAS de « 100 crédits = une vidéo » : le coût est calculé selon les
 * RESSOURCES réelles — images générées, caractères ElevenLabs, minutes de
 * rendu pondérées par résolution, stockage. Le wallet Gen3ia (reserve →
 * settle/release) couvre le rendu : réservation au lancement, règlement au
 * réel à la fin, libération sur échec.
 */

import { estimateUsageCharge, billUsage } from "@/lib/billing/media-meter";
import { reserveFunds, settleReservation, releaseReservation } from "@/lib/billing/wallet";
import { RESOLUTION_RANK } from "@/lib/video/security";

export interface RenderCostEstimate {
  renderMinutes: number;
  resolution: string;
  /** Montant estimé en unité mineure wallet (XAF minor). */
  amountMinor: number;
  breakdown: Array<{ label: string; amountMinor: number }>;
}

/** Coût de rendu par seconde pondérée (base 1080p), en unité mineure. */
const RENDER_MINOR_PER_SEC_1080P = Number(process.env.VIDEO_RENDER_MINOR_PER_SEC || "3");

const RESOLUTION_FACTOR: Record<string, number> = {
  "480p": 0.5,
  "720p": 0.75,
  "1080p": 1,
  "1440p": 1.8,
  "4K": 3.2,
};

/** Estimation du coût de rendu (réservation préalable). */
export function estimateRenderCost(params: { durationSec: number; resolution: string }): RenderCostEstimate {
  const factor = RESOLUTION_FACTOR[params.resolution] ?? 1;
  const renderMinor = Math.ceil(params.durationSec * RENDER_MINOR_PER_SEC_1080P * factor);
  return {
    renderMinutes: Math.round((params.durationSec / 60) * 10) / 10,
    resolution: params.resolution,
    amountMinor: renderMinor,
    breakdown: [
      {
        label: `Rendu ${params.resolution} (${Math.round(params.durationSec)} s × facteur ${factor})`,
        amountMinor: renderMinor,
      },
    ],
  };
}

/** Réservation du budget rendu sur le wallet (fail-closed si solde insuffisant). */
export async function reserveRenderBudget(userId: string, jobId: string, estimate: RenderCostEstimate): Promise<void> {
  await reserveFunds({
    userId,
    amountMinor: estimate.amountMinor,
    reference: `video_render_${jobId}`,
    metadata: { kind: "video_render", resolution: estimate.resolution, durationSec: String(Math.round(estimate.renderMinutes * 60)) },
  });
}

/** Règlement au réel : consomme la facturation réelle et solde la réservation. */
export async function settleRenderBudget(params: {
  userId: string;
  jobId: string;
  estimate: RenderCostEstimate;
  actualDurationSec: number;
}): Promise<number> {
  const factor = RESOLUTION_FACTOR[params.estimate.resolution] ?? 1;
  const actualMinor = Math.ceil(params.actualDurationSec * RENDER_MINOR_PER_SEC_1080P * factor);
  await billUsage({
    userId: params.userId,
    executionId: params.jobId,
    kind: "video_generation",
    quantity: params.actualDurationSec,
    complexity: factor,
    metadata: { surface: "video_agent", jobId: params.jobId },
  });
  await settleReservation({
    userId: params.userId,
    reference: `video_render_${params.jobId}`,
    reservedMinor: params.estimate.amountMinor,
    actualChargeMinor: Math.min(actualMinor, params.estimate.amountMinor),
  });
  return actualMinor;
}
/** Libération de la réservation (échec/annulation — l'utilisateur ne paie pas un rendu raté). */
export async function releaseRenderBudget(userId: string, jobId: string, reservedMinor: number): Promise<void> {
  await releaseReservation({
    userId,
    reference: `video_render_${jobId}`,
    reservedMinor,
  });
}

/** Facturation d'une image générée (kind existant : image_generation). */
export async function billImageGeneration(userId: string, projectId: string, count: number): Promise<number> {
  if (count <= 0) return 0;
  const charge = estimateUsageCharge({ kind: "image_generation", quantity: count });
  await billUsage({
    userId,
    executionId: projectId,
    kind: "image_generation",
    quantity: count,
    metadata: { surface: "video_agent" },
  });
  return charge.chargeMinor;
}

/** Facturation TTS (caractères ElevenLabs réellement consommés). */
export async function billTts(userId: string, projectId: string, charactersUsed: number): Promise<number> {
  if (charactersUsed <= 0) return 0;
  const charge = estimateUsageCharge({ kind: "tts", quantity: charactersUsed });
  await billUsage({
    userId,
    executionId: projectId,
    kind: "tts",
    quantity: charactersUsed,
    metadata: { surface: "video_agent" },
  });
  return charge.chargeMinor;
}

/** Rang de résolution pour les garde-fous de réservation. */
export function resolutionRank(resolution: string): number {
  return RESOLUTION_RANK[resolution] ?? 1;
}

/** Réservation du budget exports additionnels (encodage + stockage). */
export async function reserveExportsBudget(userId: string, jobId: string, amountMinor: number): Promise<void> {
  await reserveFunds({ userId, amountMinor, reference: `video_exports_${jobId}`, metadata: { kind: "video_exports" } });
}

/** Règlement des exports additionnels au réel. */
export async function settleExportsBudget(params: { userId: string; jobId: string; reservedMinor: number; targets: number }): Promise<void> {
  if (params.targets > 0) {
    await billUsage({
      userId: params.userId,
      executionId: params.jobId,
      kind: "compute",
      quantity: params.targets,
      metadata: { surface: "video_agent_exports" },
    });
  }
  await settleReservation({
    userId: params.userId,
    reference: `video_exports_${params.jobId}`,
    reservedMinor: params.reservedMinor,
    actualChargeMinor: params.reservedMinor,
  });
}
