import { estimateExecutionCost } from "./cost-engine";
import { getWallet, reserveFunds, settleReservation, releaseReservation } from "./wallet";

export type BillableUsageKind =
  | "image_generation" | "image_edit" | "video_generation" | "video_edit"
  | "audio_generation" | "audio_transcription" | "tts" | "voice_agent" | "voice_call"
  | "embedding" | "whatsapp_message" | "whatsapp_call" | "telegram_message" | "slack_message" | "email"
  | "social_post" | "social_video_publish" | "ads_publish" | "webhook" | "compute" | "gpu"
  | "storage_read" | "storage_write" | "network_egress";

function env(name: string, fallback: number): number { const n = Number(process.env[name]); return Number.isFinite(n) && n >= 0 ? n : fallback; }
function rawCost(kind: BillableUsageKind, quantity: number): number {
  const q = Math.max(0, quantity);
  const rates: Record<BillableUsageKind, number> = {
    image_generation: env("COST_IMAGE_GENERATION_EUR_PER_IMAGE", 0.04), image_edit: env("COST_IMAGE_EDIT_EUR_PER_IMAGE", 0.05),
    video_generation: env("COST_VIDEO_GENERATION_EUR_PER_SECOND", 0.08), video_edit: env("COST_VIDEO_EDIT_EUR_PER_SECOND", 0.04),
    audio_generation: env("COST_AUDIO_GENERATION_EUR_PER_MINUTE", 0.015), audio_transcription: env("COST_AUDIO_TRANSCRIPTION_EUR_PER_MINUTE", 0.006),
    tts: env("COST_TTS_EUR_PER_1K_CHARACTERS", 0.015), voice_agent: env("COST_VOICE_AGENT_EUR_PER_MINUTE", 0.08), voice_call: env("COST_VOICE_CALL_EUR_PER_MINUTE", 0.12),
    embedding: env("COST_EMBEDDING_EUR_PER_1M_TOKENS", 0.02), whatsapp_message: env("COST_WHATSAPP_MESSAGE_EUR", 0.01), whatsapp_call: env("COST_WHATSAPP_CALL_EUR_PER_MINUTE", 0.12),
    telegram_message: env("COST_TELEGRAM_MESSAGE_EUR", 0.001), slack_message: env("COST_SLACK_MESSAGE_EUR", 0.0005), email: env("COST_EMAIL_EUR", 0.001), social_post: env("COST_SOCIAL_POST_EUR", 0.003),
    social_video_publish: env("COST_SOCIAL_VIDEO_PUBLISH_EUR", 0.01), ads_publish: env("COST_ADS_PUBLISH_EUR", 0.02), webhook: env("COST_WEBHOOK_EUR", 0.0005),
    compute: env("COST_COMPUTE_EUR_PER_MINUTE", 0.01), gpu: env("COST_GPU_EUR_PER_MINUTE", 0.05), storage_read: env("COST_STORAGE_READ_GB_EUR", 0.01),
    storage_write: env("COST_STORAGE_WRITE_GB_EUR", 0.02), network_egress: env("COST_NETWORK_EGRESS_GB_EUR", 0.08),
  };
  return rates[kind] * q;
}

export function estimateUsageCharge(params: { kind: BillableUsageKind; quantity: number; complexity?: number; externalCostEur?: number }) {
  const raw = rawCost(params.kind, params.quantity) + Math.max(0, params.externalCostEur ?? 0);
  const complexity = Math.min(5, Math.max(0.5, params.complexity ?? 1));
  return estimateExecutionCost({ task: "automation", complexity, externalToolCostEur: raw, toolCalls: 1 });
}

export async function billUsage(params: { userId: string; executionId: string; kind: BillableUsageKind; quantity: number; complexity?: number; externalCostEur?: number; metadata?: Record<string, string> }) {
  if (!Number.isFinite(params.quantity) || params.quantity <= 0) throw new Error("Billable usage quantity must be positive.");
  const estimate = estimateUsageCharge(params); const reserveMinor = Math.max(1, estimate.reserveMinor); const reference = `usage_${params.executionId}_${crypto.randomUUID()}`;
  const wallet = await getWallet(params.userId); if (wallet.availableMinor < reserveMinor) throw new Error("Insufficient wallet balance for this operation.");
  await reserveFunds({ userId: params.userId, amountMinor: reserveMinor, reference, metadata: { kind: params.kind, quantity: String(params.quantity), ...(params.metadata ?? {}) } });
  try { await settleReservation({ userId: params.userId, reference, reservedMinor: reserveMinor, actualChargeMinor: estimate.chargeMinor, metadata: { kind: params.kind, quantity: String(params.quantity), ...(params.metadata ?? {}) } }); return { reference, ...estimate }; }
  catch (error) { await releaseReservation({ userId: params.userId, reference, reservedMinor: reserveMinor }).catch(() => undefined); throw error; }
}
