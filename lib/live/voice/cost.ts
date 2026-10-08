import "server-only";

import { detectToolIntents } from "@/lib/agents/runtime/tool-intent";
import { billUsage } from "@/lib/billing/media-meter";

import type {
  LiveVoiceDifficulty,
  LiveVoiceErrorCode,
  LiveVoiceUsageBreakdown,
} from "./protocol";

/**
 * Coût & difficulté d'un tour Live Voix (Task 110-a).
 *
 * La difficulté est calculée SERVEUR (jamais déclarée par le client) :
 *  - AVANCÉ   (complexité 2.5) : une intention outil est détectée dans le
 *    transcript (detectToolIntents, déterministe) OU la réponse dépasse
 *    900 caractères (tâche de fond) ;
 *  - STANDARD (complexité 1.6) : réponse de plus de 350 caractères ;
 *  - SIMPLE   (complexité 1.0) : sinon.
 *
 * La facturation est PAR TOUR (turnId = executionId pour billUsage) :
 *  - `audio_transcription` : quantité = secondes d'audio (skip si 0 —
 *    billUsage exige une quantité > 0) ;
 *  - `tts`                 : quantité = caractères synthétisés (skip si 0) ;
 *  - `voice_agent`         : quantité = durée du tour en MINUTES
 *    (fractionnaire, plancher 0.01), `complexity` = multiplicateur.
 *
 * `chargeMinor` (centimes d'euro) retournés par chaque appel billUsage sont
 * sommés dans `costMinor`. Solde insuffisant → erreur marquée
 * LIVE_INSUFFICIENT_FUNDS (isInsufficientFundsError).
 */

/** Solde minimum (minor) pour DÉMARRER / RENOUVELER une session Live Voix. */
export const LIVE_VOICE_MIN_BALANCE_MINOR = positiveIntEnv("LIVE_VOICE_MIN_BALANCE_MINOR", 50);

/** Multiplicateur de complexité par difficulté (contrat 110-0). */
const DIFFICULTY_COMPLEXITY: Record<LiveVoiceDifficulty, number> = {
  simple: 1.0,
  standard: 1.6,
  avance: 2.5,
};

/** Plancher de la durée facturée d'un tour (minutes — voice_agent). */
const MIN_AGENT_TURN_MINUTES = 0.01;

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Erreur de facturation marquée d'un code du protocole Live Voix. */
export class LiveVoiceBillingError extends Error {
  readonly code: LiveVoiceErrorCode;

  constructor(code: LiveVoiceErrorCode, message: string) {
    super(message);
    this.name = "LiveVoiceBillingError";
    this.code = code;
  }
}

/**
 * True si l'erreur correspond à une provision insuffisante : soit l'erreur
 * brute de billUsage/wallet (« Insufficient wallet balance… »), soit
 * l'erreur déjà enveloppée par ce module (LiveVoiceBillingError).
 */
export function isInsufficientFundsError(error: unknown): boolean {
  if (error instanceof LiveVoiceBillingError) return error.code === "LIVE_INSUFFICIENT_FUNDS";
  if (error instanceof Error) {
    return (
      error.name === "InsufficientFundsError" ||
      /insufficient (wallet )?balance/i.test(error.message)
    );
  }
  return false;
}

/** Multiplicateur de complexité d'une difficulté (paramètre `complexity`). */
export function difficultyComplexity(difficulty: LiveVoiceDifficulty): number {
  return DIFFICULTY_COMPLEXITY[difficulty];
}

/**
 * Difficulté d'un tour, calculée serveur depuis le transcript ET la réponse :
 * AVANCÉ si intention outil détectée ou réponse > 900 chars ; STANDARD si
 * réponse > 350 chars ; SIMPLE sinon.
 */
export function resolveDifficulty(transcript: string, reply: string): LiveVoiceDifficulty {
  const intents = detectToolIntents(transcript ?? "");
  if (intents.length > 0 || (reply ?? "").length > 900) return "avance";
  if ((reply ?? "").length > 350) return "standard";
  return "simple";
}

/**
 * Exécute un appel billUsage et renvoie `chargeMinor`. Solde insuffisant →
 * erreur marquée LIVE_INSUFFICIENT_FUNDS ; les autres erreurs remontent
 * brutes (l'appelant décide : LIVE_TURN_FAILED).
 */
async function billTurnKind(params: {
  userId: string;
  turnId: string;
  kind: "audio_transcription" | "tts" | "voice_agent";
  quantity: number;
  complexity?: number;
}): Promise<number> {
  try {
    const result = await billUsage({
      userId: params.userId,
      executionId: params.turnId,
      kind: params.kind,
      quantity: params.quantity,
      ...(params.complexity !== undefined ? { complexity: params.complexity } : {}),
      metadata: { surface: "live_voice" },
    });
    return result.chargeMinor;
  } catch (error) {
    if (isInsufficientFundsError(error)) {
      throw new LiveVoiceBillingError(
        "LIVE_INSUFFICIENT_FUNDS",
        "Crédit insuffisant pour poursuivre la session Live Voix. Rechargez votre portefeuille.",
      );
    }
    throw error;
  }
}

/**
 * Facture la TRANSCRIPTION du tour : `audio_transcription`, quantité =
 * secondes d'audio. Skip (0 facturé) si quantité <= 0 — billUsage exige une
 * quantité strictement positive.
 */
export async function billSttUsage(params: {
  userId: string;
  turnId: string;
  audioSeconds: number;
}): Promise<number> {
  if (!(params.audioSeconds > 0)) return 0;
  return billTurnKind({
    userId: params.userId,
    turnId: params.turnId,
    kind: "audio_transcription",
    quantity: params.audioSeconds,
  });
}

/**
 * Facture la COMPOSITION du tour (après synthèse) : `tts` (caractères
 * synthétisés, skip si 0) puis `voice_agent` (durée du tour en minutes,
 * plancher 0.01, `complexity` = multiplicateur de difficulté).
 */
export async function billCompositionUsage(params: {
  userId: string;
  turnId: string;
  ttsChars: number;
  turnDurationMs: number;
  difficulty: LiveVoiceDifficulty;
}): Promise<{ ttsMinor: number; agentMinor: number }> {
  const ttsMinor =
    params.ttsChars > 0
      ? await billTurnKind({
          userId: params.userId,
          turnId: params.turnId,
          kind: "tts",
          quantity: params.ttsChars,
        })
      : 0;

  const minutes = Math.max(0, params.turnDurationMs) / 60_000;
  const agentMinor = await billTurnKind({
    userId: params.userId,
    turnId: params.turnId,
    kind: "voice_agent",
    quantity: Math.max(minutes, MIN_AGENT_TURN_MINUTES),
    complexity: difficultyComplexity(params.difficulty),
  });

  return { ttsMinor, agentMinor };
}

export interface LiveVoiceCostResult {
  difficulty: LiveVoiceDifficulty;
  costMinor: number;
  breakdown: LiveVoiceUsageBreakdown;
}

/**
 * Facture un tour COMPLET en une fois (STT puis TTS + voice_agent) et
 * renvoie la difficulté, le coût total et la répartition. Le pipeline de
 * tour utilise les deux fonctions ci-dessus aux DEUX moments de facturation
 * (après STT, après composition) et assemble le même résultat.
 */
export async function billVoiceTurn(params: {
  userId: string;
  turnId: string;
  transcript: string;
  reply: string;
  audioSeconds: number;
  ttsChars: number;
  turnDurationMs: number;
}): Promise<LiveVoiceCostResult> {
  const difficulty = resolveDifficulty(params.transcript, params.reply);
  const sttMinor = await billSttUsage({
    userId: params.userId,
    turnId: params.turnId,
    audioSeconds: params.audioSeconds,
  });
  const { ttsMinor, agentMinor } = await billCompositionUsage({
    userId: params.userId,
    turnId: params.turnId,
    ttsChars: params.ttsChars,
    turnDurationMs: params.turnDurationMs,
    difficulty,
  });
  return {
    difficulty,
    costMinor: sttMinor + ttsMinor + agentMinor,
    breakdown: { sttMinor, ttsMinor, agentMinor },
  };
}
