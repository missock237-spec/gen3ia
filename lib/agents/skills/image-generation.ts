import "server-only";

import { detectImageRatio, enhanceImagePrompt } from "@/lib/ai/image-generation";

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
