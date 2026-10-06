import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";
import {
  IMAGE_RATIOS,
  IMAGE_SIZES,
  editImageWithAgnes,
  generateImageWithAgnes,
} from "@/lib/ai/image-generation";
import { persistGeneratedImage } from "@/lib/media/persist";

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
  /**
   * URL de l'image à utiliser : URL signée de la copie PERMANENTE (R2)
   * quand la persistance a réussi, sinon l'URL provider d'origine
   * (temporaire — repli gracieux). Rétrocompatible : toujours une URL
   * http(s) directement affichable.
   */
  url: string;
  /** URL Agnes d'ORIGINE (temporaire) — conservée pour diagnostic/audit. */
  providerUrl: string;
  provider: "agnes";
  model: string;
  latencyMs: number;
  taskId?: string;
  /** "r2" = copie permanente réussie ; "provider" = repli URL temporaire. */
  storage: "r2" | "provider";
  /**
   * Handle durable quand storage === "r2" : clé R2 complète
   * (users/<uid>/permanent/ai-images/…), re-résolvable en URL signée via
   * /api/storage/permanent?path=… — l'objet ne disparaît plus.
   */
  storagePath?: string;
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
  async execute(input, context): Promise<GenerateImageToolOutput> {
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
    // Persistance (Task 103-a, audit production 2026-10-07) : l'URL Agnes
    // est TEMPORAIRE — sans copie, l'image livrée à l'utilisateur
    // disparaissait à l'expiration. Parité avec le chat
    // (produceConversationImage) : copie en R2 permanent sous
    // users/<uid>/permanent/ai-images/. persistGeneratedImage ne lève
    // JAMAIS (dégradation gracieuse : storage:"provider" + URL d'origine).
    const persisted = await persistGeneratedImage({
      userId: context.userId,
      imageUrl: image.imageUrl,
    });
    return {
      url: persisted.url,
      providerUrl: image.imageUrl,
      provider: "agnes",
      model: image.model,
      latencyMs: image.latencyMs,
      storage: persisted.storage,
      ...(persisted.storagePath
        ? { storagePath: persisted.storagePath }
        : {}),
      ...(image.taskId ? { taskId: image.taskId } : {}),
    };
  },
};
