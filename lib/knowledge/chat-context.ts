import type { KnowledgeSearchResult } from "@/lib/knowledge/search";

/**
 * Contexte Knowledge injecté dans le tour conversationnel (étape 15).
 *
 * Défaut historique : la base de connaissances n'était accessible que via
 * une étape PLANIFIÉE (knowledge.search) — en mode chat, une question sur
 * les documents du projet (« que dit notre charte sur … ? ») recevait une
 * réponse générique sans consulter les documents. Désormais, quand la
 * conversation porte sur un projet, les fragments les plus pertinents sont
 * recherchés automatiquement et injectés avec une consigne de fidélité.
 *
 * Fonctions pures (formatage/décision) — la recherche vectorielle reste
 * dans lib/knowledge/search (déjà testée).
 */

/** Fragments injectés au maximum par tour (budget de contexte). */
export const KNOWLEDGE_CONTEXT_MAX_RESULTS = 6;
/** Longueur maximale d'aperçu par fragment. */
export const KNOWLEDGE_SNIPPET_MAX_CHARS = 700;

/**
 * Score minimal pour considérer un fragment pertinent : en dessous, les
 * résultats sont du bruit et ne doivent PAS polluer la réponse.
 */
export const KNOWLEDGE_MIN_SCORE = 0.3;

/** Décide si le contexte knowledge doit être recherché pour ce tour. */
export function shouldSearchKnowledge(input: {
  projectId?: string;
  message: string;
}): boolean {
  if (!input.projectId) return false; // knowledge est scopée par projet
  const message = input.message.trim();
  return message.length >= 15 && message.length <= 20_000;
}

/** Filtre les résultats bruités et garde les plus pertinents. */
export function selectKnowledgeResults(results: readonly KnowledgeSearchResult[]): KnowledgeSearchResult[] {
  return results
    .filter((result) => Number.isFinite(result.score) && result.score >= KNOWLEDGE_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, KNOWLEDGE_CONTEXT_MAX_RESULTS);
}

/**
 * Formate le bloc de contexte knowledge : consigne de fidélité + fragments
 * citables (avec leur source documentaire). Vide si aucun fragment pertinent.
 */
export function buildKnowledgeContext(results: readonly KnowledgeSearchResult[]): string {
  const selected = selectKnowledgeResults(results);
  if (selected.length === 0) return "";
  const blocks = selected.map((result) => {
    const snippet = result.text.trim().slice(0, KNOWLEDGE_SNIPPET_MAX_CHARS);
    return `- [document ${result.documentId}, fragment ${result.chunkIndex}, score ${result.score.toFixed(2)}]\n${snippet}`;
  });
  return `\n${blocks.join("\n\n")}`;
}
