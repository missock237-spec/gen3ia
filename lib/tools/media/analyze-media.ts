import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";
import { analyserMediaSource } from "@/lib/media/analyze";

/**
 * Outil media.analyze — ANALYSE MÉDIA LOCALE RÉELLE + TRANSCRIPTION VOCALE.
 *
 * Rend réel le contrat annoncé au registre (lib/tools/registry.ts) :
 * « analyser une image, un audio ou une vidéo » :
 *  - image  → sharp (dimensions, palette dominante, luminosité, contraste,
 *    entropie) ;
 *  - audio  → ffprobe + volumedetect (durée, codec, débit, dynamique)
 *    PLUS transcription vocale RÉELLE (ASR) via le professeur média
 *    temporaire quand il est configuré (loi CONTRAINTE-ONDES) ;
 *  - vidéo  → ffprobe + extraction d'images clés + sharp (structure de
 *    scène, évolution visuelle).
 *
 * HONNÊTETÉ : les mesures sont réelles ; sans professeur configuré, la
 * transcription vocale est ABSENTE et le résultat le dit — jamais de
 * texte inventé.
 */

const MediaAnalyzeInput = z.object({
  path: z.string().min(1).max(2000).describe(
    "Source du média : clé R2 permanente (users/<uid>/permanent/…), URL https ou data URI. " +
    "Pour une pièce jointe du compte, utiliser la clé permanente exacte (ex : file.read).",
  ),
});

/** Sortie typée de l'outil (contrat stable pour les planners). */
interface MediaAnalyzeToolOutput {
  kind: "image" | "audio" | "video";
  mime: string;
  tailleOctets: number;
  /** Résumé déterministe en français (mesures réelles). */
  resume: string;
  /** Transcription vocale (audio uniquement) — disponible ou absence honnête. */
  transcription?: {
    disponible: boolean;
    texte?: string;
    moteur?: string;
    echafaudage?: boolean;
    raison?: string;
  };
  details: Record<string, unknown>;
}

export const analyzeMediaTool: ToolDefinition<
  z.infer<typeof MediaAnalyzeInput>,
  MediaAnalyzeToolOutput
> = {
  id: "media.analyze",
  name: "media.analyze",
  description:
    "Analyse LOCALEMENT une image, un audio ou une vidéo (mesures réelles : format, dimensions, durée, codecs, " +
    "palette dominante, luminosité, contraste, images clés) et TRANSCRIT RÉELLEMENT la parole des pistes audio " +
    "(ASR) quand le professeur média est configuré (loi CONTRAINTE-ONDES) ; sinon mesures seules, " +
    "absence de transcription déclarée honnêtement — jamais de texte inventé.",
  category: "media",
  risk: "low",
  inputSchema: MediaAnalyzeInput,
  async execute(input, context): Promise<MediaAnalyzeToolOutput> {
    const analyse = await analyserMediaSource({
      userId: context.userId,
      path: input.path,
    });
    if (!analyse) {
      throw new Error(
        "Le fichier désigné n'est pas un média analysable (image, audio ou vidéo attendus).",
      );
    }
    const transcription =
      typeof analyse.details.transcription === "object" && analyse.details.transcription !== null
        ? (analyse.details.transcription as MediaAnalyzeToolOutput["transcription"])
        : undefined;
    return {
      kind: analyse.kind,
      mime: analyse.mime,
      tailleOctets: analyse.tailleOctets,
      resume: analyse.resume,
      ...(transcription ? { transcription } : {}),
      details: analyse.details,
    };
  },
};
