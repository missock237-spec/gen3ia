/**
 * CACHE D'INFÉRENCE CORTEX — mémoire LRU à durée de vie courte pour les
 * réponses du cortex langagier. Les requêtes identiques (même message +
 * même contexte de reprise) court-circuitent le scoring IDF : gain direct
 * sur les redites fréquentes (« bonjour », questions récurrentes) sans
 * toucher au déterminisme (même clé → même réponse).
 *
 * HONNÊTETÉ : le cache ne porte QUE les compositions du cortex (corpus
 * appris). Les réponses pilotage/connaissances (données vivantes du compte)
 * et le repli décodeur restent toujours calculés. La télémétrie `raw.langage.
 * cache` expose hit/miss pour l'observabilité.
 *
 * Module PUR (aucune I/O) — singleton sur globalThis pour survivre aux
 * hot-reloads dev comme le runtime neuronal.
 */

/** Capacité maximale du cache (entrées). */
export const TAILLE_CACHE_MAX = 500;

/** Durée de vie d'une entrée (ms) — courte, comme demandé. */
export const TTL_CACHE_MS = 10 * 60 * 1000;

/** Entrée de cache : composition + horodatage. La composition est figée au
 *  type exact du moteur (source union fermée) pour préserver le contrat. */
interface EntreeCache {
  composition: {
    texte: string;
    source:
      | "cortex_corpus"
      | "cortex_personnalisee"
      | "cortex_contexte"
      | "decoder_intention"
      | "pilotage"
      | "connaissances_utilisateur";
    theme?: string;
    scoreAppariement?: number;
    clePair?: string;
  };
  horodatage: number;
}

/** Hash FNV-1a (32 bits) — déterministe, sans dépendance Node. */
function fnv1a(entree: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < entree.length; i++) {
    hash ^= entree.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface CacheReponsesCortex {
  /**
   * Construit la clé de cache : identité de la conversation (compte) + message
   * normalisé + contexte de reprise. Le scope par conversation est OBLIGATOIRE
   * : les paires personnalisées d'un utilisateur ne doivent jamais servir de
   * réponse en cache à un autre compte.
   */
  cle(scope: string, prompt: string, contexte: { messagePrecedent?: string }): string;
  /** Lit une entrée encore valide (sinon null et l'entrée expirée est purgée). */
  lire(cle: string): EntreeCache["composition"] | null;
  /** Stocke une composition (éviction LRU au-delà de TAILLE_CACHE_MAX). */
  stocker(cle: string, composition: EntreeCache["composition"]): void;
  /** Statistiques (télémétrie /neural). */
  stats(): { taille: number; touches: number; requetes: number };
  /** Vide le cache (reset pédagogique). */
  vider(): void;
}

/**
 * Fabrique du cache d'inférence cortex — instancié PAR moteur (le runtime
 * neuronal étant un singleton, la persistance process est préservée ; les
 * tests créent des moteurs neufs → isolation garantie).
 */
export function creerCacheReponses(): CacheReponsesCortex {
  const entrees = new Map<string, EntreeCache>();
  let touches = 0;
  let requetes = 0;

  return {
    cle(scope, prompt, contexte) {
      const message = prompt.trim().toLowerCase().replace(/\s+/g, " ");
      const reprise = (contexte.messagePrecedent ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
      return `${scope}::${fnv1a(message)}|${fnv1a(reprise)}`;
    },

    lire(cle) {
      requetes += 1;
      const entree = entrees.get(cle);
      if (!entree) return null;
      if (Date.now() - entree.horodatage > TTL_CACHE_MS) {
        entrees.delete(cle);
        return null;
      }
      touches += 1;
      // Rafraîchit la position LRU (Map préserve l'ordre d'insertion).
      entrees.delete(cle);
      entrees.set(cle, entree);
      return entree.composition;
    },

    stocker(cle, composition) {
      if (!composition.texte.trim()) return;
      if (entrees.size >= TAILLE_CACHE_MAX) {
        const plusAncienne = entrees.keys().next().value;
        if (plusAncienne !== undefined) entrees.delete(plusAncienne);
      }
      entrees.set(cle, { composition, horodatage: Date.now() });
    },

    stats() {
      return { taille: entrees.size, touches, requetes };
    },

    vider() {
      entrees.clear();
      touches = 0;
      requetes = 0;
    },
  };
}
