import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";
import { detectImageRatio, extractImagePrompt } from "@/lib/ai/image-intent";

/**
 * Outil image.generate — GÉNÉRATION VISUELLE NEURONALE LOCALE.
 *
 * Remplace l'ancien outil branché sur Agnes AI (supprimé du projet avec
 * toutes les IA externes, sur demande explicite de l'utilisateur). La
 * composition est calculée par le moteur neuronal Gen3 depuis l'état
 * RÉEL du cerveau (poids synaptiques appris pendant l'entraînement) :
 * déterministe, instantanée, sans clé ni appel réseau.
 *
 * L'archivage permanent R2 est inclus (storagePath) : l'URL de l'outil
 * reste résolvable après expiration de l'URL signée.
 */

const ImageGenerateInput = z.object({
  prompt: z.string().min(1).max(2000).describe(
    "Description du visuel attendu (sujet, ambiance, cadrage).",
  ),
  ratio: z.enum(["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"]).optional().describe(
    "Ration d'aspect souhaité (défaut déduit du prompt, sinon 1:1).",
  ),
});

/** Sortie typée de l'outil (contrat stable pour les planners). */
interface ImageGenerateToolOutput {
  url: string;
  storage: "r2" | "inline";
  mime: string;
  details: string;
}

export const generateImageNeuralTool: ToolDefinition<
  z.infer<typeof ImageGenerateInput>,
  ImageGenerateToolOutput
> = {
  id: "image.generate",
  name: "image.generate",
  description:
    "Génère une composition visuelle NEURONALE calculée depuis l'état réel du cerveau Gen3 " +
    "(constellation synaptique apprise, palette dérivée du prompt). Moteur local : aucune IA externe.",
  category: "media",
  risk: "low",
  inputSchema: ImageGenerateInput,
  async execute(input, context): Promise<ImageGenerateToolOutput> {
    const { genererVisuelNeuralEtPersister } = await import("@/lib/neural/media-service");
    const prompt = extractImagePrompt(input.prompt);
    const result = await genererVisuelNeuralEtPersister({
      userId: context.userId,
      prompt,
      ratio: input.ratio ?? detectImageRatio(input.prompt),
    });

    return {
      url: result.url,
      storage: result.storage,
      mime: result.mime,
      details:
        `Composition neuronale générée localement (${String(result.meta.moteur ?? "gen3-snn-visuel-v1")}) — ` +
        `${String(result.meta.nbNoeuds ?? "?")} nœuds / ${String(result.meta.nbAretes ?? "?")} arêtes issues des synapses réelles.`,
    };
  },
};
