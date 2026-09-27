import { z } from "zod";

import { runAIJSON } from "@/lib/engines/ai-engine";

/**
 * AMÉLIORATION AUTOMATIQUE DES PROMPTS (demande utilisateur) :
 * après l'envoi d'un prompt, le système l'améliore pour maximiser le
 * résultat final SANS JAMAIS TRAHIR la demande de l'utilisateur :
 *  - la langue d'origine est conservée ;
 *  - l'intention, les contraintes et les données énoncées sont intangibles ;
 *  - l'amélioration ajoute du contexte, clarifie l'objectif et explicite le
 *    livrable attendu.
 *
 * Rapidité : chemin déterministe pour les prompts déjà structurés
 * (> 40 mots avec connecteurs d'intention), un seul appel LLM court
 * (≤ 700 tokens) sinon, repli silencieux sur le prompt d'origine en cas
 * de moindre problème — l'amélioration ne doit JAMAIS ralentir ni casser
 * une demande qui fonctionne.
 */

export interface PromptEnhancement {
  /** Prompt d'origine (intangible). */
  original: string;
  /** Prompt amélioré (ou original si aucune amélioration n'a été produite). */
  enhanced: string;
  /** true si le prompt a réellement été réécrit par le système. */
  improved: boolean;
  /** Raison courte (traçabilité / affichage discret dans la timeline). */
  reason: string;
}

const EnhancementSchema = z.object({
  enhanced: z.string().min(8).max(4000),
  notes: z.string().max(200).optional(),
});

/** Le prompt est-il déjà suffisamment structuré pour passer sans LLM ? */
export function isPromptAlreadyStructured(message: string): boolean {
  const words = message.trim().split(/\s+/).filter(Boolean);
  if (words.length > 40) return true;
  const structured = /(^|\n)\s*([-*•]|\d+[.)])|\b(étapes?|objectif|livrable|contraintes?|format attendu)\b/i;
  return structured.test(message) && words.length >= 18;
}

export function detectLanguage(message: string): "fr" | "en" | "autre" {
  if (/\b(le|la|les|une|un|des|pour|avec|dans|crée|créer|fais|génère|écris|analyse)\b/i.test(message)) return "fr";
  if (/\b(the|and|for|with|create|make|write|build|analyze)\b/i.test(message)) return "en";
  return "autre";
}

function deterministicEnhancement(message: string): PromptEnhancement {
  const language = detectLanguage(message);
  const deliverable =
    language === "en"
      ? "\n\n(Execution context: deliver the concrete, complete, verifiable result — no invented data.)"
      : "\n\n(Contexte d'exécution : délivre le résultat concret, complet et vérifiable — aucune donnée inventée.)";
  return {
    original: message,
    enhanced: `${message.trim()}${deliverable}`,
    improved: false,
    reason: language === "en" ? "renforcement déterministe (en)" : "renforcement déterministe (fr)",
  };
}

/** Améliore un prompt destiné à l'exécution d'une tâche. */
export async function enhancePromptForExecution(params: {
  userId: string;
  message: string;
}): Promise<PromptEnhancement> {
  const text = params.message.trim();
  if (!text) return { original: params.message, enhanced: params.message, improved: false, reason: "vide" };

  // Rapidité : prompts déjà structurés → renforcement déterministe uniquement.
  if (isPromptAlreadyStructured(text)) return deterministicEnhancement(text);

  try {
    const result = await runAIJSON({
      userId: params.userId,
      feature: "conversation-turn",
      system:
        "Tu es un optimiseur de prompts pour un agent IA universel. Réécris la demande de l'utilisateur pour MAXIMISER le résultat de l'agent : " +
        "objectif explicite, livrable attendu, contraintes, critères de réussite. " +
        "RÈGLES ABSOLUES : conserve EXACTEMENT la langue de l'utilisateur ; ne change JAMAIS l'intention ; n'invente AUCUNE donnée, URL, nom ou chiffre absent de la demande ; reste concis (3 phrases maximum). " +
        'Réponds STRICTEMENT en JSON : { "enhanced": "<prompt amélioré>", "notes": "<1 courte phrase>" }.',
      prompt: text,
      maxTokens: 700,
      temperature: 0.2,
      schema: EnhancementSchema,
      label: "prompt amélioré",
    });

    const enhanced = result.data.enhanced.trim();
    if (enhanced.length < 8 || enhanced.length > 4000) return deterministicEnhancement(text);
    // Garde-fou anti-dérive : le premier mot porteur du sujet doit survivre.
    const firstMeaningful = text.toLowerCase().split(/\s+/).find((word) => word.length >= 4) ?? "";
    if (firstMeaningful && !enhanced.toLowerCase().includes(firstMeaningful)) {
      return deterministicEnhancement(text);
    }
    return {
      original: text,
      enhanced,
      improved: enhanced !== text,
      reason: result.data.notes?.slice(0, 160) || "réécriture par l'optimiseur",
    };
  } catch {
    return deterministicEnhancement(text);
  }
}
