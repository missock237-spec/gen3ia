import "server-only";

import { randomUUID } from "node:crypto";

import { elevenLabsTextToSpeech } from "@/lib/integrations/elevenlabs/client";
import { isR2Configured, uploadToR2 } from "@/lib/storage/r2";
import { billUsage } from "@/lib/billing/media-meter";

/**
 * VOIX-OFF DIRECTE (Task 114-a — « Interface Universelle »).
 *
 * Intercept chat : une demande explicite de voix-off est servie
 * IMMÉDIATEMENT par synthèse vocale, sans passer par un plan de mission.
 * Mécanique calquée SUR L'OUTIL voice.speak (lib/integrations/elevenlabs/
 * tools.ts — lu, jamais édité) :
 *  - synthèse ElevenLabs (voix par défaut du serveur, multilingue FR) ;
 *  - archivage permanent R2 users/{uid}/permanent/ai-audio/{ts}-{uuid}.{ext}
 *    — la clé devient la référence durable (résolvable par le canal signé
 *    de l'application) ; échec d'archivage → repli data URI inline,
 *    JAMAIS d'échec de livraison pour un échec de stockage ;
 *  - facturation AU MÊME TARIF que l'outil : l'outil passe par la
 *    réserve/règlement du tool-meter à l'exécution ; l'appel direct est
 *    facturé via billUsage kind "tts" sur les caractères RÉELLEMENT
 *    consommés (même rate COST_TTS_EUR_PER_1K_CHARACTERS). Une facturation
 *    impossible (solde insuffisant) refuse le service : l'audio gratuit
 *    n'est jamais livré.
 *
 * FAIL-SOFT : la synthèse (TTS indisponible) et l'archivage (R2 indisponible)
 * peuvent échouer sans lever — l'appelant (route chat) continue alors le
 * flux normal (planificateur), sans erreur visible brute.
 */

/** Plafond de caractères par synthèse (même contrat que l'outil voice.speak). */
const MAX_TTS_CHARS = 2500;

export interface SpeakDirectResult {
  /** true = audio synthétisé, facturé et livré (r2 ou inline). */
  ok: boolean;
  /** Clé R2 permanente de l'audio (storage "r2"), sinon absent. */
  audioUrl?: string;
  storage?: "r2" | "inline";
  /** Data URI de l'audio (toujours présent ; unique livrable en repli inline). */
  dataUri?: string;
  voiceId?: string;
  charactersUsed?: number;
  reason?: string;
}

export async function speakDirectForUser(params: {
  userId: string;
  /** Texte à synthétiser (tronqué au quota outil : 2 500 caractères). */
  text: string;
  /** Identifiant d'exécution pour la facturation (référence ledger). */
  executionId: string;
  voiceId?: string;
}): Promise<SpeakDirectResult> {
  const text = params.text.trim().slice(0, MAX_TTS_CHARS);
  if (!text || !params.userId?.trim()) {
    return { ok: false, reason: "Texte ou utilisateur manquant pour la synthèse vocale." };
  }

  // 1) Synthèse — échec TTS → fail-soft (flux normal de la route).
  let synthesis;
  try {
    synthesis = await elevenLabsTextToSpeech({
      text,
      ...(params.voiceId ? { voiceId: params.voiceId } : {}),
    });
  } catch (error) {
    console.warn(
      "[voice-speak-direct] synthèse ElevenLabs indisponible — flux normal conservé :",
      error instanceof Error ? error.message : error,
    );
    return { ok: false, reason: "Synthèse vocale indisponible." };
  }

  // 2) Facturation au réel (même tarif que l'outil) — solde insuffisant →
  //    pas d'audio gratuit : l'appelant garde le flux normal.
  if (synthesis.charactersUsed > 0) {
    try {
      await billUsage({
        userId: params.userId,
        executionId: params.executionId,
        kind: "tts",
        quantity: synthesis.charactersUsed,
        metadata: { surface: "chat_voice_direct" },
      });
    } catch (error) {
      console.warn(
        "[voice-speak-direct] facturation TTS impossible — voix-off non livrée :",
        error instanceof Error ? error.message : error,
      );
      return { ok: false, reason: "Facturation de la synthèse vocale impossible." };
    }
  }

  const audioDataUri = `data:${synthesis.mimeType};base64,${synthesis.audioBase64}`;

  // 3) Archivage permanent R2 — mécanique identique à voice.speak ; échec
  //    → repli data URI inline (l'audio est livré quand même).
  let audioUrl: string | undefined;
  let storage: "r2" | "inline" = "inline";
  try {
    const buffer = Buffer.from(synthesis.audioBase64, "base64");
    if (buffer.byteLength > 0 && isR2Configured()) {
      const ext = synthesis.mimeType.includes("wav")
        ? "wav"
        : synthesis.mimeType.includes("ogg")
          ? "ogg"
          : "mp3";
      const key = `users/${params.userId}/permanent/ai-audio/${Date.now()}-${randomUUID()}.${ext}`;
      await uploadToR2(key, buffer, synthesis.mimeType);
      audioUrl = key;
      storage = "r2";
    }
  } catch (storageError) {
    console.warn(
      "[voice-speak-direct] archivage R2 permanent échoué — audio livré en data URI inline :",
      storageError instanceof Error ? storageError.message : String(storageError),
    );
  }

  return {
    ok: true,
    dataUri: audioDataUri,
    ...(audioUrl ? { audioUrl } : {}),
    storage,
    voiceId: synthesis.voiceId,
    charactersUsed: synthesis.charactersUsed,
  };
}
