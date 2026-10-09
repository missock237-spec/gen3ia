import { randomUUID } from "node:crypto";
import { z } from "zod";

import type {
  ToolDefinition,
} from "@/lib/tools/types";

import { isR2Configured, uploadToR2 } from "@/lib/storage/r2";

import {
  ELEVENLABS_MODELS,
  elevenLabsTextToSpeech,
  listElevenLabsVoices,
} from "./client";

const MAX_TTS_CHARS = 2500;

const SpeakInput = z.object({
  text: z
    .string()
    .min(1)
    .max(MAX_TTS_CHARS),

  voiceId: z
    .string()
    .min(10)
    .max(64)
    .optional(),

  modelId: z
    .enum(ELEVENLABS_MODELS)
    .optional(),
});

interface SpeakOutput {
  audioDataUri: string;

  /** Référence permanente R2 (clé) quand le stockage a réussi, sinon absent. */
  url?: string;

  /** "r2" = audio persisté en permanence ; "inline" = seul le data URI existe. */
  storage: "r2" | "inline";

  mimeType: string;

  voiceId: string;

  modelId: string;

  charactersUsed: number;

  note: string;
}

/**
 * Synthese vocale a partir d'un texte (voix naturelles multilingues,
 * francais supporte via eleven_multilingual_v2).
 */
export const voiceSpeakTool: ToolDefinition<
  z.infer<typeof SpeakInput>,
  SpeakOutput
> = {
  id: "voice.speak",

  name: "Voice Speak",

  description:
    "Convertit un texte en audio MP3 naturel (voix ElevenLabs, francais supporte). " +
    `Maximum ${MAX_TTS_CHARS} caracteres par appel (quota mensuel du compte).`,

  category: "system",

  risk: "low",

  inputSchema: SpeakInput,

  async execute(
    input,
    context,
  ): Promise<SpeakOutput> {
    const result =
      await elevenLabsTextToSpeech({
        text: input.text,
        voiceId: input.voiceId,
        modelId: input.modelId,
      });

    // Le data URI reste dans la sortie (contrat rétrocompatible) : le chat
    // et les clients existants continuent de le lire tel quel.
    const audioDataUri = `data:${result.mimeType};base64,${result.audioBase64}`;

    // Persistance permanente — pattern identique au chat (engine.ts :
    // users/<uid>/permanent/ai-audio/<ts>-<uuid>.<ext>) mais effectué ici,
    // à la source, pour que l'audio survive même hors conversation.
    // JAMAIS de throw si le stockage échoue : dégradation assumée en
    // "inline" (seul le data URI est retourné), l'outil reste utilisable.
    let url: string | undefined;
    let storage: "r2" | "inline" = "inline";
    try {
      const buffer = Buffer.from(result.audioBase64, "base64");
      if (buffer.byteLength > 0 && context.userId && isR2Configured()) {
        const ext = result.mimeType.includes("wav")
          ? "wav"
          : result.mimeType.includes("ogg")
            ? "ogg"
            : "mp3";
        const key = `users/${context.userId}/permanent/ai-audio/${Date.now()}-${randomUUID()}.${ext}`;
        await uploadToR2(key, buffer, result.mimeType);
        // Clé R2 = référence permanente (le canal signé de l'application
        // la résout en URL de téléchargement côté panneau des artefacts).
        url = key;
        storage = "r2";
      }
    } catch (storageError) {
      // Stockage indisponible (R2 non configuré, panne, quota) : on garde
      // le data URI inline — jamais d'échec de synthèse pour un échec de
      // stockage. Task 113 : l'incident est JOURNALISÉ (plus de catch muet).
      console.warn(
        "[voice.speak] archivage R2 permanent échoué — audio livré en data URI inline :",
        storageError instanceof Error ? storageError.message : String(storageError),
      );
    }

    return {
      audioDataUri,

      ...(url ? { url } : {}),

      storage,

      mimeType: result.mimeType,

      voiceId: result.voiceId,

      modelId: result.modelId,

      charactersUsed: result.charactersUsed,

      note:
        storage === "r2"
          ? `Audio MP3 synthétisé et stocké définitivement (${url}) ; data URI conservé en sortie.`
          : "Audio MP3 encode en base64 (data URI) — lisible dans le navigateur ou telechargeable.",
    };
  },
};

const ListVoicesInput = z.object({});

interface ListVoicesOutput {
  voices: Array<{
    voiceId: string;
    name: string;
    category: string;
    language?: string;
    accent?: string;
    previewUrl?: string;
  }>;
  defaultVoiceHint: string;
}

/** Liste les voix disponibles sur le compte (bibliotheque + personnalisees). */
export const voiceListTool: ToolDefinition<
  z.infer<typeof ListVoicesInput>,
  ListVoicesOutput
> = {
  id: "voice.list",

  name: "Voice List",

  description:
    "Liste les voix ElevenLabs disponibles (nom, langue, accent, extrait d'ecoute).",

  category: "system",

  risk: "low",

  inputSchema: ListVoicesInput,

  async execute(
    _input,
    _context,
  ): Promise<ListVoicesOutput> {
    const voices =
      await listElevenLabsVoices();

    return {
      voices: voices.map((voice) => ({
        voiceId: voice.voiceId,

        name: voice.name,

        category: voice.category,

        language: voice.labels.language,

        accent: voice.labels.accent,

        previewUrl: voice.previewUrl,
      })),

      defaultVoiceHint:
        "Utiliser un voiceId retourne par cet outil dans voice.speak ; sans voiceId, la voix par defaut du serveur est appliquee.",
    };
  },
};
