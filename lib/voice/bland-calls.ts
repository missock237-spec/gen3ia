import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/observability/logger";
import { billUsage } from "@/lib/billing/media-meter";
import { getBlandCall, normalizeBlandCallDetails, type BlandCallDetails } from "@/lib/integrations/bland/client";

/**
 * REGISTRE DES APPELS VOCAUX BLAND (collection Firestore « voiceCalls »).
 *
 * Chaque appel lancé par Gen3ia est matérialisé par un document dont
 * l'identifiant EST le call_id Bland : les webhooks post-appel et le
 * polling de suivi convergent vers la même clé, en écriture idempotente.
 * L'historique (transcripts, résumé, enregistrement, facturation miroir)
 * est mis à jour par applyBlandCallDetails — appelé aussi bien par le
 * webhook entrant que par le rafraîchissement manuel.
 */

const CALLS_COLLECTION = "voiceCalls";
const DAILY_COLLECTION = "voiceCallDaily";

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Quota journalier d'appels vocaux par utilisateur. */
export const MAX_DAILY_VOICE_CALLS = positiveIntEnv("GEN3IA_MAX_DAILY_VOICE_CALLS", 20);

/** Solde wallet minimal (centimes d'euro) pour DÉMARRER un appel vocal. */
export const VOICE_CALL_MIN_BALANCE_MINOR = Number(process.env.GEN3IA_VOICE_CALL_MIN_BALANCE_MINOR ?? 100);

/** Statuts terminaux (arrêt du suivi temps réel côté UI). */
export const TERMINAL_VOICE_CALL_STATUSES = new Set(["completed", "failed", "busy", "no-answer", "canceled"]);

export type VoiceCallStatus =
  | "queued"
  | "in-progress"
  | "completed"
  | "failed"
  | "busy"
  | "no-answer"
  | "canceled"
  | "unknown";

/** Tour de conversation normalisé (compat avec l'ancien format history). */
export interface VoiceCallTurn {
  role: "assistant" | "user";
  text: string;
  at: string;
}

export interface VoiceCallRecord {
  id: string;
  provider: "bland";
  userId: string;
  agentId?: string;
  agentName?: string;
  blandAgentId?: string;
  direction: "outbound";
  to: string;
  from: string | null;
  objective: string;
  language: string;
  status: VoiceCallStatus;
  completed: boolean;
  answeredBy?: string | null;
  callEndedBy?: string | null;
  lengthMinutes?: number | null;
  priceUsd?: number | null;
  recordingUrl?: string | null;
  summary?: string | null;
  history: VoiceCallTurn[];
  lastError?: string | null;
  billing?: { chargedMinor?: number; billedAt?: number };
  resume?: string;
  summarizedAt?: number;
  createdAt: number;
  updatedAt: number;
  lastSyncedAt?: number;
}

/** Statut d'affichage depuis les détails bruts Bland. */
export function normalizeBlandStatus(details: BlandCallDetails): VoiceCallStatus {
  if (details.completed) {
    const known: VoiceCallStatus[] = ["completed", "failed", "busy", "no-answer", "canceled"];
    return known.includes(details.status as VoiceCallStatus) ? (details.status as VoiceCallStatus) : "completed";
  }
  if (details.queueStatus === "active" || details.queueStatus === "in-progress") return "in-progress";
  if (details.queueStatus === "complete") return "completed";
  return "queued";
}

function toRecord(id: string, data: Record<string, unknown>): VoiceCallRecord {
  const history: VoiceCallTurn[] = Array.isArray(data.history)
    ? (data.history as Array<Record<string, unknown>>).flatMap((turn): VoiceCallTurn[] => {
        const role: "assistant" | "user" | null =
          turn?.role === "assistant" ? "assistant" : turn?.role === "user" ? "user" : null;
        const text = typeof turn?.text === "string" ? turn.text : "";
        return role && text ? [{ role, text, at: typeof turn.at === "string" ? turn.at : "" }] : [];
      })
    : [];
  return {
    id,
    provider: "bland",
    userId: String(data.userId ?? ""),
    agentId: typeof data.agentId === "string" ? data.agentId : undefined,
    agentName: typeof data.agentName === "string" ? data.agentName : undefined,
    blandAgentId: typeof data.blandAgentId === "string" ? data.blandAgentId : undefined,
    direction: "outbound",
    to: String(data.to ?? ""),
    from: typeof data.from === "string" ? data.from : null,
    objective: String(data.objective ?? ""),
    language: String(data.language ?? "fr-FR"),
    status: (data.status as VoiceCallStatus) ?? "queued",
    completed: Boolean(data.completed),
    answeredBy: typeof data.answeredBy === "string" ? data.answeredBy : null,
    callEndedBy: typeof data.callEndedBy === "string" ? data.callEndedBy : null,
    lengthMinutes: typeof data.lengthMinutes === "number" ? data.lengthMinutes : null,
    priceUsd: typeof data.priceUsd === "number" ? data.priceUsd : null,
    recordingUrl: typeof data.recordingUrl === "string" ? data.recordingUrl : null,
    summary: typeof data.summary === "string" ? data.summary : null,
    history,
    lastError: typeof data.lastError === "string" ? data.lastError : null,
    billing:
      data.billing && typeof data.billing === "object"
        ? (data.billing as { chargedMinor?: number; billedAt?: number })
        : undefined,
    resume: typeof data.resume === "string" ? data.resume : undefined,
    summarizedAt: typeof data.summarizedAt === "number" ? data.summarizedAt : undefined,
    createdAt: Number(data.createdAt ?? 0),
    updatedAt: Number(data.updatedAt ?? 0),
    lastSyncedAt: typeof data.lastSyncedAt === "number" ? data.lastSyncedAt : undefined,
  };
}

/** Réserve un quota journalier (transaction sur compteur — échoue si dépassé). */
export async function reserveDailyVoiceCallSlot(userId: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const ref = adminDb.collection(DAILY_COLLECTION).doc(`${userId}_${day}`);
  await adminDb.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const count = snap.exists && typeof snap.data()?.count === "number" ? Number(snap.data()?.count) : 0;
    if (count >= MAX_DAILY_VOICE_CALLS) {
      throw new Error(
        `Limite quotidienne d'appels vocaux atteinte (${MAX_DAILY_VOICE_CALLS} appels/jour).`,
      );
    }
    transaction.set(ref, { userId, day, count: count + 1, updatedAt: Date.now() }, { merge: true });
  });
}

export interface CreateVoiceCallParams {
  callId: string;
  userId: string;
  agentId?: string;
  agentName?: string;
  blandAgentId?: string;
  to: string;
  from?: string | null;
  objective: string;
  language: string;
}

/** Matérialise l'appel AVANT renvoi au client (id = call_id Bland). */
export async function createVoiceCallRecord(params: CreateVoiceCallParams): Promise<VoiceCallRecord> {
  const now = Date.now();
  const record: Record<string, unknown> = {
    provider: "bland",
    userId: params.userId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.agentName ? { agentName: params.agentName } : {}),
    ...(params.blandAgentId ? { blandAgentId: params.blandAgentId } : {}),
    direction: "outbound",
    to: params.to,
    from: params.from ?? null,
    objective: params.objective,
    language: params.language,
    status: "queued",
    completed: false,
    history: [],
    createdAt: now,
    updatedAt: now,
  };
  await adminDb.collection(CALLS_COLLECTION).doc(params.callId).set(record);
  return toRecord(params.callId, record);
}

export async function getVoiceCall(callId: string): Promise<VoiceCallRecord | null> {
  const snap = await adminDb.collection(CALLS_COLLECTION).doc(callId).get();
  if (!snap.exists) return null;
  return toRecord(snap.id, snap.data() ?? {});
}

/** Propriété vérifiée (fail-closed : introuvable ≠ accès). */
export async function assertVoiceCallOwner(userId: string, callId: string): Promise<VoiceCallRecord> {
  const record = await getVoiceCall(callId);
  if (!record || record.userId !== userId) {
    throw new Error("Appel introuvable.");
  }
  return record;
}

export async function listVoiceCalls(userId: string, agentId?: string, limit = 40): Promise<VoiceCallRecord[]> {
  const snapshot = await adminDb
    .collection(CALLS_COLLECTION)
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .limit(Math.min(100, limit))
    .get();
  return snapshot.docs
    .map((doc) => toRecord(doc.id, doc.data() ?? {}))
    .filter((record) => !agentId || record.agentId === agentId);
}

/**
 * Fusionne les détails Bland dans l'enregistrement local (idempotent) :
 * statut normalisé, transcripts, résumé, enregistrement, erreurs. La
 * facturation miroir (wallet, kind voice_call) n'est exécutée QU'UNE
 * FOIS par appel, à la première complétion facturable.
 */
export async function applyBlandCallDetails(
  callId: string,
  details: BlandCallDetails,
  options?: { bill?: boolean },
): Promise<VoiceCallRecord | null> {
  const existing = await getVoiceCall(callId);
  if (!existing) return null;

  const status = normalizeBlandStatus(details);
  const hasTranscripts = details.transcripts.length > 0;
  const patch: Record<string, unknown> = {
    status,
    completed: details.completed,
    updatedAt: Date.now(),
    lastSyncedAt: Date.now(),
    answeredBy: details.answeredBy,
    callEndedBy: details.callEndedBy,
    lastError: details.errorMessage,
    ...(details.lengthMinutes !== null ? { lengthMinutes: details.lengthMinutes } : {}),
    ...(details.priceUsd !== null ? { priceUsd: details.priceUsd } : {}),
    ...(details.recordingUrl ? { recordingUrl: details.recordingUrl } : {}),
    ...(hasTranscripts ? { history: details.transcripts } : {}),
    ...(details.summary ? { summary: details.summary } : {}),
  };

  // Facturation miroir : une seule fois, à la complétion, au prorata des
  // minutes réellement consommées (tarif COST_VOICE_CALL_EUR_PER_MINUTE).
  const billable =
    (options?.bill ?? true) &&
    details.completed &&
    !TERMINAL_VOICE_CALL_STATUSES.has("queued") /* no-op garde typing */ &&
    typeof existing.billing?.chargedMinor !== "number" &&
    (details.lengthMinutes ?? 0) > 0;
  if (billable) {
    try {
      const charged = await billUsage({
        userId: existing.userId,
        executionId: `voice-call-${callId}`,
        kind: "voice_call",
        quantity: Math.max(0.01, details.lengthMinutes ?? 0),
        metadata: existing.agentId ? { agentId: existing.agentId } : undefined,
      });
      patch.billing = { chargedMinor: charged.chargeMinor, billedAt: Date.now() };
    } catch (error) {
      // Fail-soft : l'enregistrement Bland reste valide même si le wallet
      // n'a pas pu être débité (solde insuffisant, indisponibilité) —
      // l'incident est journalisé pour traitement manuel.
      logger.error({ callId, err: error }, "bland_call_billing_failed");
    }
  }

  await adminDb.collection(CALLS_COLLECTION).doc(callId).update(patch);
  return getVoiceCall(callId);
}

/** Rafraîchit un enregistrement depuis l'API Bland (polling de suivi). */
export async function syncVoiceCallFromBland(callId: string): Promise<VoiceCallRecord | null> {
  try {
    const details = await getBlandCall(callId);
    return applyBlandCallDetails(callId, details, { bill: true });
  } catch (error) {
    logger.warn({ callId, err: error }, "bland_call_sync_failed");
    return getVoiceCall(callId);
  }
}

/** Enregistre le résumé IA mis en cache (route summary). */
export async function saveVoiceCallSummary(callId: string, summary: string): Promise<void> {
  await adminDb
    .collection(CALLS_COLLECTION)
    .doc(callId)
    .update({ resume: summary, summarizedAt: Date.now() })
    .catch(() => undefined);
}

/** Utilisé par le webhook : normalise le payload brut puis applique. */
export function normalizeWebhookPayload(payload: Record<string, unknown>): BlandCallDetails {
  return normalizeBlandCallDetails(payload);
}
