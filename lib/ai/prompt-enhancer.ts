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

/**
 * Mots vides FR / EN (listes DISJOINTES par conception : tout mot ambigu
 * dans les deux langues — « on », « me », « plus », « or »… — est exclu des
 * deux listes pour ne pas biaiser le score).
 */
const FRENCH_STOPWORDS_RE =
  /\b(je|tu|il|elle|nous|vous|ils|elles|le|la|les|l'|un|une|des|du|de|au|aux|et|mais|donc|ni|pour|avec|dans|sur|sous|pas|plus|très|bien|ce|cet|cette|ces|mon|ma|mes|ton|ta|tes|son|sa|ses|notre|votre|leur|est|sont|sommes|être|avoir|te|se|qui|que|quoi|quand|comment|pourquoi|combien|où|oui|non|merci|bonjour|salut|bonsoir|voici|voilà|besoin|veux|voudrais|aimerais|peux|pourrais|dois|fais|faire|crée|créer|génère|générer|écris|rédige|analyse)\b/gi;

const ENGLISH_STOPWORDS_RE =
  /\b(the|an|and|for|with|in|at|to|of|is|are|was|were|be|been|have|has|had|do|does|did|you|your|this|that|these|those|my|please|thanks|thank|hello|hi|hey|need|want|would|could|should|can|will|make|create|write|build|generate|analyze|send|get|give|when|what|why|how|who|where|which|about|from|into|then|there|here)\b/gi;

/** Caractères accentués typiques du français (l'anglais n'en possède aucun). */
const FRENCH_ACCENTED_CHARS_RE = /[àâäçéèêëîïôöùûüÿœæ]/gi;

/**
 * Détection de langue ROBUSTE (audit : les deux regexes initiales renvoyaient
 * « autre » pour des messages parfaitement français) :
 *  1. score de mots vides FR vs EN (listes disjointes) ;
 *  2. signe fort français : les caractères accentués n'existent pas en anglais.
 * Retourne "fr", "en" ou "other" (langue non couverte : allemand, arabe…).
 */
export function detectLanguage(message: string): "fr" | "en" | "other" {
  const text = message.trim();
  if (!text) return "other";
  const fr = (text.match(FRENCH_STOPWORDS_RE) ?? []).length;
  const en = (text.match(ENGLISH_STOPWORDS_RE) ?? []).length;
  if (fr > en) return "fr";
  if (en > fr) return "en";
  // Égalité (ou absence de mot vide) : les accents tranchent (≥ 2 signaux).
  const accented = (text.match(FRENCH_ACCENTED_CHARS_RE) ?? []).length;
  return accented >= 2 ? "fr" : "other";
}

/**
 * Directive de LANGUE à injecter dans les prompts système (décision
 * d'intention ET tour conversationnel) : l'agent répond IMPÉRATIVEMENT dans
 * la langue du DERNIER message utilisateur — plus jamais une réponse
 * française à une question anglaise (ou l'inverse). Fonction pure.
 */
export function languageDirective(userText: string): string {
  const language = detectLanguage(userText);
  if (language === "fr") {
    return "LANGUE : réponds impérativement en français (langue détectée du dernier message).";
  }
  if (language === "en") {
    return "LANGUE : réponds impérativement en anglais (langue détectée du dernier message).";
  }
  return "LANGUE : réponds dans la langue du dernier message de l'utilisateur.";
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
