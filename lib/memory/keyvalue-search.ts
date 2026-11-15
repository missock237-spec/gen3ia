/**
 * Recherche textuelle des souvenirs clé/valeur (« Mémoire permanente »).
 *
 * Historique : /api/memory/search n'indexait QUE les souvenirs épisodiques
 * (collection `memories` + Qdrant) ; les souvenirs clé/valeur de la collection
 * `userMemories` étaient invisibles (n=0). Ce module les réintègre avec une
 * recherche sous-chaîne insensible à la casse sur clé ET valeur, un scoring
 * simple (exact > préfixe > sous-chaîne) et une fusion dédupliquée avec les
 * résultats sémantiques — le tout en fonctions pures, sans Firestore.
 */

/** Barème de correspondance (1.0 aligné sur une similarité cosinus parfaite). */
export const KEYVALUE_SCORES = { EXACT: 1, PREFIX: 0.8, SUBSTRING: 0.6, VALUE: 0.4 } as const;

/** Plafond dur du nombre de résultats fusionnés renvoyés par l'API. */
export const MERGED_RESULTS_MAX = 20;

/** Entrée clé/valeur telle que renvoyée par listMemories (user-memory.ts). */
export interface KeyValueMemoryEntry {
  key: string;
  value: string;
  source?: string;
  updatedAt?: string;
}

/** Hit clé/valeur compatible avec le format des résultats épisodiques. */
export interface KeyValueSearchHit {
  id: string;
  type: "keyvalue";
  content: string;
  createdAt: string;
  key: string;
  score: number;
  source: "keyvalue";
}

/** Identifiant stable et préfixé : ne peut pas entrer en collision avec les UUID épisodiques. */
export function keyValueHitId(key: string): string {
  return `kv:${key}`;
}

/** Normalisation de comparaison : casse + espaces de bout en bout. */
function comparable(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Score de correspondance d'une requête sur une entrée clé/valeur.
 * 0 = aucun match (l'entrée est exclue des résultats).
 */
export function scoreKeyValueMatch(query: string, key: string, value: string): number {
  const q = comparable(query);
  if (q.length === 0) return 0;
  const k = comparable(key);
  const v = comparable(value);
  if (k === q) return KEYVALUE_SCORES.EXACT;
  if (k.startsWith(q)) return KEYVALUE_SCORES.PREFIX;
  if (k.includes(q)) return KEYVALUE_SCORES.SUBSTRING;
  if (v.includes(q)) return KEYVALUE_SCORES.VALUE;
  return 0;
}

/**
 * Recherche k/v : filtre les entrées correspondantes, trie par score puis par
 * fraîcheur (updatedAt desc) comme départage, et borne au `limit`.
 */
export function searchKeyValueEntries(
  entries: KeyValueMemoryEntry[],
  query: string,
  limit = MERGED_RESULTS_MAX,
): KeyValueSearchHit[] {
  return entries
    .map((entry) => ({ entry, score: scoreKeyValueMatch(query, entry.key, entry.value) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Départage déterministe : souvenirs les plus récents d'abord, puis clé alphabétique.
      const timeDelta = timestampOf(b.entry.updatedAt) - timestampOf(a.entry.updatedAt);
      if (timeDelta !== 0) return timeDelta;
      return a.entry.key.localeCompare(b.entry.key);
    })
    .slice(0, Math.max(0, limit))
    .map((match): KeyValueSearchHit => ({
      id: keyValueHitId(match.entry.key),
      type: "keyvalue",
      content: match.entry.value,
      createdAt: match.entry.updatedAt ?? "",
      key: match.entry.key,
      score: Number(match.score.toFixed(4)),
      source: "keyvalue",
    }));
}

function timestampOf(iso?: string): number {
  if (!iso) return 0;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Fusion des résultats épisodiques (Qdrant/cosinus) et clé/valeur :
 * déduplication par identifiant (les épisodiques, listés en premier,
 * gagnent en cas de collision improbable), tri par score décroissant
 * (tri stable : à score égal l'ordre d'arrivée est conservé), plafond `limit`.
 * Deux paramètres génériques : les hits épisodiques et k/v n'ont pas
 * exactement les mêmes champs mais partagent { id, score }.
 */
export function mergeMemoryResults<
  A extends { id: string; score: number },
  B extends { id: string; score: number },
>(
  episodic: A[],
  keyValue: B[],
  limit = MERGED_RESULTS_MAX,
): Array<A | B> {
  const seen = new Set<string>();
  const merged: Array<A | B> = [];
  for (const hit of [...episodic, ...keyValue]) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    merged.push(hit);
  }
  return merged
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
}
