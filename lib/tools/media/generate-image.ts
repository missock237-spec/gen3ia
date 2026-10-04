import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";
import {
  IMAGE_RATIOS,
  IMAGE_SIZES,
  editImageWithAgnes,
  generateImageWithAgnes,
} from "@/lib/ai/image-generation";

/**
 * Outil image.generate — génération d'image RÉELLE (audit outils médias).
 *
 * Aujourd'hui la conversation intercepte « image.generate » comme étape
 * planifiée fantôme (lib/domain/conversations/engine.ts) alors qu'aucun
 * ToolDefinition exécutable n'existe : l'outil n'apparaît ni dans le
 * registre, ni dans la sécurité, ni dans le résolveur d'alias. Ce module
 * comble le trou avec l'implémentation Agnes AI déjà en production
 * (lib/ai/image-generation.ts) — la MÊME voie que le chat, sans facturation
 * supplémentaire (parité avec le comportement conversationnel actuel).
 *
 * - Sans image de référence : voie text-to-image (generateImageWithAgnes).
 * - Avec refImageUrls (1 à 4) : voie édition/composition image-to-image
 *   (editImageWithAgnes) — retouche, changement de fond, stylisation,
 *   composition multi-images, en préservant la composition d'origine.
 * - Les erreurs réelles remontent TELLES QUELLES (ImageGenerationError) :
 *   aucun masquage, aucun repli silencieux.
 */

const GenerateImageInput = z.object({
  /** Description visuelle fidèle de l'image demandée. */
  prompt: z.string().min(3).max(4000),
  /** Cadrage (ratios supportés par le modèle Agnes). */
  ratio: z.enum(IMAGE_RATIOS).optional(),
  /** Taille de rendu (1K → 4K, défaut Agnes : 1K). */
  size: z.enum(IMAGE_SIZES).optional(),
  /**
   * Images sources pour l'édition/composition (1 à 4) : URLs https publiques
   * ou Data URI Base64 — même contrat que lib/ai/image-generation.ts.
   */
  refImageUrls: z.array(z.string().url()).max(4).optional(),
});

export interface GenerateImageToolOutput {
  url: string;
  provider: "agnes";
  model: string;
  latencyMs: number;
  taskId?: string;
}

export const generateImageTool: ToolDefinition<
  z.infer<typeof GenerateImageInput>,
  GenerateImageToolOutput
> = {
  id: "image.generate",
  name: "Image Generation",
  description:
    "Generate a REAL image from a text description (Agnes AI), with optional aspect ratio, render size and 1-4 reference images for editing/composition.",
  category: "media",
  risk: "medium",
  inputSchema: GenerateImageInput,
  async execute(input): Promise<GenerateImageToolOutput> {
    const prompt = input.prompt.trim();
    const common = {
      prompt,
      ...(input.ratio ? { ratio: input.ratio } : {}),
      ...(input.size ? { size: input.size } : {}),
    };
    // Voie édition/composition dès qu'au moins une image de référence est
    // fournie — sinon génération text-to-image classique.
    const image = input.refImageUrls && input.refImageUrls.length > 0
      ? await editImageWithAgnes({ ...common, images: input.refImageUrls })
      : await generateImageWithAgnes(common);
    return {
      url: image.imageUrl,
      provider: "agnes",
      model: image.model,
      latencyMs: image.latencyMs,
      ...(image.taskId ? { taskId: image.taskId } : {}),
    };
  },
};
