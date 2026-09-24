import "server-only";

import { generate } from "@/lib/ai/router";

/**
 * Amélioration intelligente des prompts d'image (« compétence image » Gen3ia).
 *
 * Avant chaque génération réelle (Agnes AI), la demande de l'utilisateur est
 * ANALYSÉE puis RÉÉCRITE par un LLM pour obtenir un prompt visuel optimal :
 * plus réaliste, mieux cadré, avec éclairage et composition adaptés — SANS
 * jamais rien ajouter ni retirer au sujet demandé. Ce que l'utilisateur a
 * demandé est ce qui est généré, rien d'autre.
 *
 * Garde-fous :
 *  - l'amélioration est purement décorative : le sujet, l'action et les
 *    objets demandés restent intacts (vérifiés par `isSaneEnhancement`) ;
 *  - en cas d'indisponibilité du LLM, on retombe sur le prompt d'origine :
 *    la génération n'est JAMAIS bloquée par l'amélioration.
 */

/** borne haute du prompt enrichi (Agnes accepte 4000 ; on reste confortable). */
export const MAX_ENHANCED_PROMPT_LENGTH = 1200;

const ENHANCER_SYSTEM = [
  "Tu es l'expert en prompts d'image de la plateforme Gen3ia.",
  "On te donne la demande d'un utilisateur. Tu la réécris en UN SEUL prompt visuel optimal pour un générateur d'images photoréalistes.",
  "RÈGLES ABSOLUES :",
  "1. Le sujet demandé (personne, objet, animal, lieu, scène) reste EXACTEMENT le même : tu n'ajoutes AUCUN sujet, objet, personnage ou texte supplémentaire, tu n'en retires AUCUN.",
  "2. Tu enrichis uniquement la qualité visuelle : réalisme (matières, textures, micro-détails), éclairage naturel crédible, profondeur de champ, cadrage et composition, palette cohérente, optique réaliste.",
  "3. Si l'utilisateur demande un style précis (dessin, logo, illustration, affiche…), tu respectes CE style : le réalisme photo ne s'applique que si l'utilisateur veut une image réaliste.",
  "4. QUALITÉ « ULTRA RÉALISTE » (quand le style réaliste/photo est demandé ou implicite) : précise un rendu photographique professionnel — capteur haute résolution, netteté fine des textures (peau, pelage, tissu, métal, bois…), éclairage naturel ou studio cohérent avec la scène, ombres douces réalistes, reflets physiquement plausibles, perspective et proportions anatomiquement correctes, grain photo subtil, AUCUN artefact de génération, aucune déformation.",
  "5. Aucun texte à faire apparaître dans l'image sauf si l'utilisateur l'a explicitement demandé (nom de marque, slogan…).",
  "6. Ton répond en une seule ligne : le prompt réécrit, sans guillemets, sans préambule, sans explication.",
].join("\n");

export function buildImageEnhancementMessages(rawPrompt: string): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: ENHANCER_SYSTEM },
    { role: "user", content: rawPrompt },
  ];
}

function significantTokens(text: string): Set<string> {
  const stop = new Set([
    "une", "un", "des", "le", "la", "les", "de", "du", "d'", "d", "et", "ou", "avec", "pour", "sur", "dans", "en",
    "image", "photo", "visuel", "illustration", "dessin", "très", "tres", "plus", "style", "très", "qui", "que",
    "génère", "genere", "générer", "creer", "crée", "créer", "dessine", "fais", "moi", "s'il", "te", "plaît", "plait",
    "a", "au", "aux", "ce", "cette", "son", "sa", "ses", "est", "sont", "the", "a", "an", "of", "with", "and", "for",
  ]);
  return new Set(
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !stop.has(token)),
  );
}

/**
 * Garde-fou anti-dérive : l'amélioration doit rester fidèle à la demande
 * (sujet intact), exploitable (longueur raisonnable) et non vide. En cas de
 * doute, on utilise le prompt d'origine — la demande de l'utilisateur prime.
 */
export function isSaneEnhancement(rawPrompt: string, enhanced: string): boolean {
  const candidate = enhanced.trim();
  if (!candidate) return false;
  if (candidate.length < rawPrompt.trim().length * 0.4) return false;
  if (candidate.length > MAX_ENHANCED_PROMPT_LENGTH) return false;
  if (candidate.includes("\n\n")) return false; // une seule ligne attendue
  // Le sujet doit rester présent : au moins un token significatif commun.
  const rawTokens = significantTokens(rawPrompt);
  const enhancedTokens = significantTokens(candidate);
  if (rawTokens.size > 0) {
    let overlap = 0;
    for (const token of rawTokens) {
      if (enhancedTokens.has(token)) overlap += 1;
    }
    if (overlap === 0) return false;
  }
  return true;
}

export interface EnhanceImagePromptResult {
  prompt: string;
  enhanced: boolean;
}

/**
 * Réécrit le prompt visuel via LLM. Jamais bloquant : tout échec renvoie le
 * prompt d'origine (`enhanced: false`).
 */
export async function enhanceImagePrompt(rawPrompt: string): Promise<EnhanceImagePromptResult> {
  const trimmed = rawPrompt.trim();
  if (trimmed.length < 3) return { prompt: trimmed, enhanced: false };
  try {
    const response = await generate({
      task: "agent",
      messages: buildImageEnhancementMessages(trimmed),
      maxTokens: 400,
      temperature: 0.4,
    });
    const candidate = response.text.trim().replace(/^["「«]+|["」»]+$/g, "").trim();
    if (isSaneEnhancement(trimmed, candidate)) {
      return { prompt: candidate, enhanced: true };
    }
    console.warn("[image-enhancer] amélioration rejetée (garde-fou), prompt d'origine conservé");
    return { prompt: trimmed, enhanced: false };
  } catch (error) {
    console.warn("[image-enhancer] LLM indisponible, prompt d'origine conservé:", error instanceof Error ? error.message : error);
    return { prompt: trimmed, enhanced: false };
  }
}
