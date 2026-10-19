import "server-only";

// Module externe (Agnes) supprimé en Task 150 : l'intention image vit
// désormais dans lib/ai/image-intent (pur, sans générateur externe).
import { detectImageRatio, enhanceImagePrompt } from "@/lib/ai/image-intent";

/**
 * Compétence spécialisée Gen3ia pour les demandes d'image.
 * Elle ne change pas le sujet demandé : elle nettoie l'intention, déduit
 * uniquement le cadrage explicitement demandé et ajoute des contraintes
 * neutres de qualité/absence d'éléments non demandés.
 */
export function buildImageGenerationSkill(userRequest: string): {
  skill: "image-generation";
  prompt: string;
  ratio: ReturnType<typeof detectImageRatio>;
} {
  return {
    skill: "image-generation",
    prompt: enhanceImagePrompt(userRequest),
    ratio: detectImageRatio(userRequest),
  };
}
