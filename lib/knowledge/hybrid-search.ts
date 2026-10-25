/**
 * RECHERCHE HYBRIDE (BM25 + RRF) — couche de rerank lexical par-dessus la
 * recherche vectorielle. Pourquoi : les embeddings lexicaux (hashing 512-d)
 * capturent le recouvrement de tokens mais pénalisent les TERMES RARES et
 * les ENTITÉS NOMMÉES (pas de pondération tf-idf) ; un score BM25 sur le
 * pool de candidats, fusionné au classement vectoriel par RRF (Reciprocal
 * Rank Fusion), remonte les fragments contenant le terme rare recherché.
 *
 * HONNÊTETÉ D'ÉCHELLE : le BM25 s'applique au pool de candidats ramenés par
 * le vecteur (+ corpus global), pas à un index lexical global — c'est un
 * RERANK hybride, pas un moteur BM25 full-text. C'est le compromis juste
 * sans infrastructure d'index inversé persistée (Qdrant ne porte pas de
 * champ full-text) ; la fenêtre du pool est élargie (×5) pour le laisser
 * travailler.
 *
 * CONTRAT DE SCORE : le score COSINUS vectoriel reste exposé tel quel
 * (les seuils consommateurs — KNOWLEDGE_MIN_SCORE=0.3, etc. — restent
 * valides) ; la FUSION RRF ne change que l'ORDRE des résultats.
 *
 * Kill-switch : KNOWLEDGE_HYBRID_OFF=1 restaure l'ordre purement vectoriel
 * (lu à chaque recherche, sans redéploiement).
 */

/** Paramètres BM25 canoniques (Okapi). */
const BM25_K1 = 1.5;
const BM25_B = 0.75;
/** Constante RRF canonique (Cheng et al.) : atténue l'écart de têtes. */
const RRF_K = 60;

/** Stopwords compacts FR + EN (les tokens fonctionnels n'apportent rien au BM25). */
const STOPWORDS_HYBRIDE = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "au", "aux",
  "ce", "cet", "cette", "ces", "ne", "pas", "plus", "pour", "par", "avec",
  "dans", "sur", "en", "y", "a", "se", "sa", "son", "ses", "leur", "leurs",
  "nous", "vous", "je", "me", "te", "ils", "elles", "on", "mais", "comme",
  "tout", "tous", "toute", "toutes", "est", "sont", "peut", "être", "qui",
  "que", "quoi", "dont", "the", "an", "of", "to", "and", "or", "in", "on",
  "for", "with", "is", "are", "be", "do", "you", "your", "it", "at", "this",
  "that", "was", "were", "been", "have", "has", "had", "not", "but", "from",
]);

/** Normalisation d'un token : minuscule + accents repliés. */
function normaliserToken(token: string): string {
  return token
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Tokenizer BM25 : mots alphanumériques, stopwords exclus, ≥ 2 caractères. */
function tokenizerBM25(texte: string): string[] {
  return normaliserToken(texte ?? "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS_HYBRIDE.has(t));
}

export function isRechercheHybrideActive(): boolean {
  const flag = process.env.KNOWLEDGE_HYBRID_OFF?.trim().toLowerCase();
  return flag !== "1" && flag !== "true";
}

/**
 * Calcule les scores BM25 de la requête contre chaque document du pool.
 * Déterministe ; pool vide → tableau vide.
 */
export function scoresBM25(
  query: string,
  documents: string[],
): number[] {
  const tokensRequete = tokenizerBM25(query);
  if (tokensRequete.length === 0 || documents.length === 0) {
    return documents.map(() => 0);
  }

  // Indexation du pool : fréquences par document + longueurs.
  const freqs = documents.map((doc) => {
    const freq = new Map<string, number>();
    for (const token of tokenizerBM25(doc)) {
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
    return freq;
  });
  const longueurs = freqs.map((freq) => {
    let total = 0;
    for (const valeur of freq.values()) total += valeur;
    return Math.max(1, total);
  });
  const longueurMoyenne =
    longueurs.reduce((somme, l) => somme + l, 0) / documents.length;

  // Document frequency par token de requête.
  const df = new Map<string, number>();
  for (const token of new Set(tokensRequete)) {
    let compte = 0;
    for (const freq of freqs) {
      if (freq.has(token)) compte += 1;
    }
    df.set(token, compte);
  }

  const N = documents.length;
  return freqs.map((freq, i) => {
    let score = 0;
    for (const token of tokensRequete) {
      const tf = freq.get(token) ?? 0;
      if (tf === 0) continue;
      const n = df.get(token) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const norm =
        (tf * (BM25_K1 + 1)) /
        (tf + BM25_K1 * (1 - BM25_B + (BM25_B * longueurs[i]!) / longueurMoyenne));
      score += idf * norm;
    }
    return score;
  });
}

export interface CandidatHybride {
  id: string;
  score: number;
}

/**
 * FUSION RRF : combine le classement vectoriel (score cosinus, déjà trié
 * décroissant par l'appelant) et le classement BM25 du pool. Le score
 * VECTORIEL d'origine est PRÉSERVÉ (contrat de seuils) ; seul l'ordre suit
 * la fusion. Égalités : ordre vectoriel (déterministe, plus ancien d'abord).
 */
export function fusionRRF<T extends CandidatHybride>(
  query: string,
  candidats: T[],
  extraireTexte: (candidat: T) => string,
  limit: number,
): T[] {
  if (candidats.length <= 1 || !isRechercheHybrideActive()) {
    return candidats.slice(0, limit);
  }

  const scoresLexicaux = scoresBM25(
    query,
    candidats.map((candidat) => extraireTexte(candidat)),
  );

  // Classement vectoriel : l'ordre d'entrée EST le classement (l'appelant
  // fournit déjà un pool trié par score décroissant).
  const rrf = new Map<string, number>();
  candidats.forEach((candidat, rang) => {
    rrf.set(candidat.id, 1 / (RRF_K + rang + 1));
  });
  // Classement lexical : tri stable décroissant des scores BM25.
  const rangLexical = scoresLexicaux
    .map((score, indice) => ({ score, indice }))
    .filter((entree) => entree.score > 0)
    .sort((a, b) => b.score - a.score);
  rangLexical.forEach((entree, rang) => {
    const candidat = candidats[entree.indice]!;
    rrf.set(candidat.id, (rrf.get(candidat.id) ?? 0) + 1 / (RRF_K + rang + 1));
  });

  return [...candidats]
    .sort((a, b) => (rrf.get(b.id) ?? 0) - (rrf.get(a.id) ?? 0))
    .slice(0, limit);
}

/**
 * Élargit la fenêtre de rappel vectorielle pour donner de la matière au
 * rerank (pool ×5, plafonné à 100 — cardinalité maîtrisée).
 */
export function poolPourHybride(limit: number): number {
  return Math.min(100, Math.max(limit * 5, 25));
}
