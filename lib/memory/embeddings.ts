import {
  embedderLexical,
  similariteCosinus,
} from "@/lib/neural/encoding/lexical-embedding";

/**
 * EMBEDDINGS DE MÉMOIRE — encodeur LEXICAL LOCAL.
 *
 * Les embeddings distants (Hugging Face Inference — IA externe) ont été
 * SUPPRIMÉS du projet sur demande explicite de l'utilisateur. La mémoire
 * sémantique (rappel épisodique, recherche vectorielle) repose
 * désormais sur l'encodeur lexical local Gen3 :
 * lib/neural/encoding/lexical-embedding.ts (hashing trick déterministe
 * unigrammes + bigrammes, dimension 512, normalisation L2).
 *
 * Contrat inchangé pour les consommateurs :
 *  - createMemoryEmbedding(text) → vecteur (toujours disponible, aucun
 *    réseau, aucune clé, aucune latence externe) ;
 *  - memoryEmbeddingSimilarity(a, b) → similarité cosinus.
 *
 * Confidentialité : les vecteurs restent EN PROCESSUS (cache LRU),
 * jamais persistés ni loggés.
 */

/**
 * Embedding lexical local d'un texte (déterministe, instantané, sans
 * dépendance externe).
 */
export async function createMemoryEmbedding(
  text: string,
): Promise<number[]> {
  return embedderLexical(text);
}

/** Similarité cosinus entre deux embeddings de mémoire. */
export function memoryEmbeddingSimilarity(
  a: number[],
  b: number[],
): number {
  return similariteCosinus(a, b);
}
