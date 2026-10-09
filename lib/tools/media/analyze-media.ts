import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";
import { analyzeMediaContent, loadMediaSource, type MediaKind } from "@/lib/media/analysis";

/**
 * Outil media.analyze — analyse RÉELLE d'image / audio / vidéo (agent IA).
 *
 * Branche l'agent (runs de tâches, workspace) sur la couche d'analyse média
 * (lib/media/analysis.ts) : vision (routeur IA) pour les images, ASR
 * ElevenLabs Scribe + LLM pour l'audio, FFmpeg (métadonnées + frames clés)
 * + Scribe + vision pour la vidéo. La conversation est connectée par le
 * moteur (analyzeAttachedMediaContext — même module) : l'utilisateur joint
 * un média et l'assistant le lit vraiment.
 *
 * Sources acceptées :
 *  - path : clé R2 PERMANENTE du PROPRIÉTAIRE (users/<uid>/… — vérifié) ;
 *  - url  : URL https publique (l'agent peut réanalyser un média produit
 *    par la plateforme, ex. artefact vidéo).
 */

const AnalyzeMediaInput = z.object({
  /** Clé R2 du stockage permanent du propriétaire (users/<uid>/…). */
  path: z.string().min(3).max(600).optional(),
  /** URL https publique du média (artefact plateforme ou ressource ouverte). */
  url: z.string().url().max(2000).optional(),
  /** Question précise à poser sur le média (défaut : description complète). */
  question: z.string().max(1200).optional(),
  /** Nom de fichier (repli type MIME si la source n'en porte pas). */
  filename: z.string().max(200).optional(),
});

export interface AnalyzeMediaToolOutput {
  kind: MediaKind;
  filename: string;
  analysis: string;
  providerLabel: string;
  metadata?: { durationSec?: number; width?: number; height?: number; fps?: number };
}

export const analyzeMediaTool: ToolDefinition<
  z.infer<typeof AnalyzeMediaInput>,
  AnalyzeMediaToolOutput
> = {
  id: "media.analyze",
  name: "Media Analysis",
  description:
    "Analyze a REAL image, audio or video file (vision model, ElevenLabs Scribe transcription, FFmpeg key frames). Provide a storage path (users/<uid>/…) or a public https URL, plus an optional question.",
  category: "media",
  risk: "low",
  inputSchema: AnalyzeMediaInput,
  async execute(input, context): Promise<AnalyzeMediaToolOutput> {
    if (!input.path && !input.url) {
      throw new Error("Fournissez une source : path (stockage permanent) ou url (https).");
    }
    const source = await loadMediaSource({
      userId: context.userId,
      path: input.path,
      url: input.url,
      fallbackFilename: input.filename,
    });
    const result = await analyzeMediaContent({
      buffer: source.buffer,
      mimeType: source.mimeType,
      filename: source.filename,
      question: input.question,
    });
    return {
      kind: result.kind,
      filename: result.filename,
      analysis: result.analysis,
      providerLabel: result.providerLabel,
      ...(result.metadata ? { metadata: result.metadata } : {}),
    };
  },
};
