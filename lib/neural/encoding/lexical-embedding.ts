/**
 * EMBEDDING LEXICAL LOCAL — remplacement interne des embeddings distants.
 *
 * Les embeddings Hugging Face (Inference API — IA externe, supprimés du
 * projet) sont remplacés par un encodeur 100 % LOCAL : un vecteur creux
 * réduit de dimension fixe (hashing trick) construit à partir des
 * UNIGRAMMES + BIGRAMMES du texte, pondéré par fréquence et normalisé L2.
 *
 * Propriétés :
 *  - DÉTERMINISTE : le même texte produit toujours le même vecteur
 *    (aucun état, aucun réseau, aucun appel externe) ;
 *  - SEMANTIQUE LEXICALE honnête : la similarité cosinus mesure le
 *    recouvrement lexical (mots et paires de mots adjacents) — c'est
 *    déclaré, jamais présenté comme de la sémantique profonde ;
 *  - CACHE LRU mémoire (confidentialité : les vecteurs restent en
 *    processus, jamais persistés ni loggés).
 *
 * La tokenisation réutilise celle de l'encodeur neuronal Gen3
 * (lib/neural/encoding/text-encoder.ts) — minuscules, diacritiques
 * retirés, découpage non-alphanumérique.
 *
 * Module PUR — aucune dépendance Node.
 */

import { tokenize } from "./text-encoder";

/** Dimension fixe des vecteurs (puissance de 2 — masque rapide). */
export const DIMENSION_EMBEDDING = 512;

/** Taille maximale du cache LRU. */
const CACHE_MAX = 1000;

/** Hash FNV-1a 32 bits local (stable, sans dépendance). */
function fnv1a(texte: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < texte.length; i++) {
    hash ^= texte.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Cache LRU (texte → vecteur). */
const cache = new Map<string, number[]>();

/**
 * Construit l'embedding lexical local : unigrammes + bigrammes, pondérés
 * en fréquence (1 + log(tf)), projetés par hashing trick et normalisés.
 */
export function embedderLexical(texte: string): number[] {
  const cle = texte.slice(0, 4000);
  const enCache = cache.get(cle);
  if (enCache) {
    // Rajeunissement LRU.
    cache.delete(cle);
    cache.set(cle, enCache);
    return enCache;
  }

  const tokens = tokenize(texte).slice(0, 2000);
  const vecteur = new Array<number>(DIMENSION_EMBEDDING).fill(0);

  // Fréquences des n-grammes (unigrammes + bigrammes adjacents).
  const frequences = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    const unigramme = tokens[i]!;
    frequences.set(unigramme, (frequences.get(unigramme) ?? 0) + 1);
    if (i + 1 < tokens.length) {
      const bigramme = `${tokens[i]}_${tokens[i + 1]}`;
      frequences.set(bigramme, (frequences.get(bigramme) ?? 0) + 1);
    }
  }

  // Projection hashée pondérée (pondération sub-linéaire des répétitions).
  for (const [gram, tf] of frequences) {
    const indice = fnv1a(gram) % DIMENSION_EMBEDDING;
    const signe = fnv1a(`${gram}#s`) & 1 ? 1 : -1; // signe stable (réduction des collisions)
    vecteur[indice] += signe * (1 + Math.log(tf));
  }

  // Normalisation L2 (similarité cosinus directe).
  let norme = 0;
  for (const valeur of vecteur) norme += valeur * valeur;
  norme = Math.sqrt(norme);
  if (norme > 0) {
    for (let i = 0; i < DIMENSION_EMBEDDING; i++) {
      vecteur[i] = vecteur[i]! / norme;
    }
  }

  cache.set(cle, vecteur);
  if (cache.size > CACHE_MAX) {
    const ancienne = cache.keys().next().value;
    if (ancienne !== undefined) cache.delete(ancienne);
  }

  return vecteur;
}

/** Similarité cosinus entre deux vecteurs (0 si dimensions incompatibles). */
export function similariteCosinus(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let produit = 0;
  let normeA = 0;
  let normeB = 0;
  for (let i = 0; i < a.length; i++) {
    produit += a[i]! * b[i]!;
    normeA += a[i]! * a[i]!;
    normeB += b[i]! * b[i]!;
  }
  if (normeA === 0 || normeB === 0) return 0;
  return produit / (Math.sqrt(normeA) * Math.sqrt(normeB));
}
