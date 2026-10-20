import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";
import { genererAudioNeuralEtPersister } from "@/lib/neural/media-service";

/**
 * Outil voice.speak — SYNTHÈSE AUDIO LOCALE RÉELLE.
 *
 * Rend réel le contrat annoncé depuis longtemps au planificateur
 * (unified-agent AUDIO RULE, catalogue conversationnel) : l'outil
 * voice.speak était PROMIS mais aucun exécuteur n'existait — toute étape
 * planifiée échouait « Unknown tool: voice.speak » (audit multimodal).
 *
 * Moteur : composition harmonique NEURONALE locale (mêmes moteurs que les
 * signaux audio du corps sémantique) — déterministe, instantanée, sans IA
 * externe ni clé. HONNÊTETÉ : le rendu est une composition sonore dérivée
 * du texte (rythme, tons, intensité) — CE N'EST PAS une parole humaine
 * naturelle ; aucune reconnaissance ni synthèse vocale parlée n'existe
 * dans le moteur local. La note accompagne chaque résultat pour que ni le
 * planner ni l'utilisateur ne soient trompés.
 *
 * Sortie compatible avec le contrat artefact du moteur conversationnel
 * (lib/domain/conversations/engine.ts) :
 *  - `url` = clé R2 PERMANENTE (users/<uid>/permanent/…) réutilisée
 *    telle quelle comme storagePath de l'artefact (Task 113) ;
 *  - `audioDataUri` = repli inline quand R2 est indisponible.
 */

const VoiceSpeakInput = z.object({
  text: z.string().min(1).max(4000).describe(
    "Le texte EXACT source de la synthèse (fidèle à la demande utilisateur).",
  ),
  dureeSecondes: z.number().int().min(1).max(30).optional().describe(
    "Durée souhaitée en secondes (défaut dérivé du texte, borné 4–30 s).",
  ),
});

/** Sortie typée de l'outil (contrat stable pour les planners). */
interface VoiceSpeakToolOutput {
  /** Clé R2 permanente (users/<uid>/permanent/ai-audio/…) quand archivé. */
  url?: string;
  /** "r2" = archivé en permanence ; "inline" = repli data URI. */
  storage: "r2" | "inline";
  /** Data URI audio (repli inline uniquement). */
  audioDataUri?: string;
  /** URL signée d'écoute immédiate (expire — le handle durable est url). */
  ecouterUrl: string;
  mimeType: "audio/wav";
  dureeSecondes: number;
  moteur: string;
  /** Note d'honnêteté sur la nature du rendu (signal neural, pas parole). */
  note: string;
}

/** Durée par défaut dérivée du texte (≈ 0,45 s/mot, bornée 4–30 s). */
export function dureeDuTexte(texte: string): number {
  const mots = texte.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(4, Math.min(30, Math.round(mots * 0.45) || 6));
}

export const voiceSpeakTool: ToolDefinition<
  z.infer<typeof VoiceSpeakInput>,
  VoiceSpeakToolOutput
> = {
  id: "voice.speak",
  name: "voice.speak",
  description:
    "Synthétise un fichier AUDIO local à partir d'un texte : composition harmonique neuronale déterministe " +
    "(rythme et tons dérivés du texte), instantanée, archivée en stockage permanent. " +
    "Moteur local — ce n'est pas de la parole naturelle.",
  category: "media",
  risk: "low",
  inputSchema: VoiceSpeakInput,
  async execute(input, context): Promise<VoiceSpeakToolOutput> {
    const rendu = await genererAudioNeuralEtPersister({
      userId: context.userId,
      prompt: input.text.trim(),
      dureeSecondes: input.dureeSecondes ?? dureeDuTexte(input.text),
      frequenceEchantillonnage: 22050,
    });

    const estPermanent = rendu.storage === "r2" && typeof rendu.cleStockage === "string";
    return {
      // Contrat artefact : `url` = clé permanente résolvable (Task 113).
      ...(estPermanent ? { url: rendu.cleStockage } : {}),
      storage: rendu.storage,
      // Repli inline : data URI lisible par le lecteur embarqué (bornée).
      ...(rendu.storage === "inline" ? { audioDataUri: rendu.url } : {}),
      ecouterUrl: rendu.url,
      mimeType: "audio/wav",
      dureeSecondes: typeof rendu.meta.duree === "number" ? rendu.meta.duree : 0,
      moteur: String(rendu.meta.moteur ?? "gen3-snn-audio-v1"),
      note:
        "Audio synthétisé localement par le moteur neuronal Gen3 (composition harmonique dérivée du texte). " +
        "Ce rendu n'est pas une parole humaine naturelle — le moteur local n'inclut pas de synthèse vocale parlée.",
    };
  },
};
