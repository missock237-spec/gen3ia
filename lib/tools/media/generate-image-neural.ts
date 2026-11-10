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
    "Génère une IMAGE PHOTORÉALISTE RÉELLE via le professeur média temporaire quand la passerelle " +
    "est configurée (échafaudage loi CONTRAINTE-ONDES — rendu photo, lumière naturelle, profondeur de champ). " +
    "Sans passerelle : composition neuronale locale honnête (abstraite, JAMAIS photoréaliste — signalé).",
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

    // HONNÊTETÉ par moteur : le label doit nommer le moteur RÉEL utilisé.
    const moteur = String(result.meta.moteur ?? "gen3-snn-visuel-v1");
    const details = moteur.startsWith("professeur")
      ? `Image photoréaliste RÉELLE via le professeur média temporaire (${moteur}, ` +
        `taille ${String(result.meta.taille ?? "?")}, ${Number(result.meta.octets ?? 0).toLocaleString("fr-FR")} octets) — ` +
        `échafaudage loi CONTRAINTE-ONDES : le signal d'onde gen3 prendra le relais après distillation.`
      : `Composition neuronale générée localement (${moteur}) — ` +
        `${String(result.meta.nbNoeuds ?? "?")} nœuds / ${String(result.meta.nbAretes ?? "?")} arêtes issues des synapses réelles ` +
        `(professeur média indisponible : rendu abstrait, PAS photoréaliste).`;

    return {
      url: result.url,
      storage: result.storage,
      mime: result.mime,
      details,
    };
  },
};
