/**
 * CACHE DE RÉPONSES — LRU + TTL + single-flight (coalescing).
 *
 * RÔLE (Task 9-a — performance/échelle) : absorber les rafales de requêtes
 * IDENTIQUES sur les hot paths idempotents en un seul calcul par fenêtre TTL.
 * Deux propriétés combinées :
 *
 *  1. LRU + TTL : taille STRICTEMENT bornée (entrées + budget mémoire
 *     approximatif), récence rafraîchie à la lecture, expiration par TTL
 *     vérifiée à chaque accès — aucune croissance indéfinie entre deux
 *     cold starts (même contrat que lib/cache/redis.ts) ;
 *  2. SINGLE-FLIGHT (coalescing) : N appels simultanés sur la même clé
 *     partagent UNE SEULE promesse de calcul — le calculateur n'est
 *     exécuté qu'une fois (protège Firestore, les sondes fournisseurs
 *     et tout calcul coûteux contre les effets de bord de rafale).
 *
 * HONNÊTETÉ DES STATS :
 *  - `hits` / `misses` : comptage exact des servis depuis le cache vs calculs
 *    déclenchés (les appels rejoints en vol comptent comme miss pour le
 *    chef de file et comme `coalesced` pour les suivants) ;
 *  - `latenceGagneeMs` : ESTIMATION honnête = somme des durées de calcul
 *    initial que les hits et les requêtes coalescées n'ont PAS eu à payer.
 *    C'est un minorant : elle ignore le coût I/O évité au-delà du CPU mesuré.
 *
 * PÉRIMÈTRE (garde-fou anti-empoisonnement) : ce cache est destiné aux
 * réponses GLOBALES et idempotentes (catalogues, config, stats publiques).
 * JAMAIS de cache sur les réponses IA personnalisées ni sur des données
 * privées sans identifiant utilisateur DANS la clé de cache — la clé doit
 * être namespacée et, si la réponse dépend d'un utilisateur, l'uid DOIT
 * en faire partie (ou mieux : ne pas mettre ce contenu en cache).
 *
 * Module PUR : aucun import, aucune I/O, aucune exception avalée
 * silencieusement sur les erreurs de calcul (elles remontent à l'appelant).
 * Le singleton vit sur globalThis (résiste au hot-reload Next en dev).
 */

/** Clé du singleton par défaut sur globalThis. */
const CLE_GLOBALE = "__gen3iaCacheReponses__";

/** Plafond d'entrées par défaut (pages/catalogues/variantes courantes). */
const ENTREES_MAX_DEFAUT = 1_000;

/** Budget mémoire approximatif par défaut (~25 Mo de JSON cumulé). */
const OCTETS_MAX_DEFAUT = 25 * 1024 * 1024;

/** Taille JSON approximative d'une valeur (borne défensive : jamais throw). */
function tailleApproximativeOctets(valeur: unknown): number {
  try {
    const serialise = JSON.stringify(valeur);
    return serialise ? serialise.length : 8;
  } catch {
    // Valeur non sérialisable (cycle…) : taille forfaitaire bornée — elle
    // reste stockable en mémoire (jamais relue par sérialisation).
    return 1024;
  }
}

/** Espace de noms de clé : lettres minuscules, chiffres et tirets, court. */
const NAMESPACE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Construit une clé de cache NAMESPACÉE. Convention : le premier segment
 * (`namespace`) isole l'usage, le second DOIT être une version (`v1`, `v2`…)
 * — incrémenter la version invalide instantanément toutes les entrées de
 * l'espace sans purge. Les segments restants identifient la variante.
 * Lance TypeError sur un namespace invalide (erreur de programmation : mieux
 * vaut échouer en développement que servir une clé ambiguë en production).
 */
export function cleCache(namespace: string, ...segments: Array<string | number | boolean>): string {
  if (!NAMESPACE_RE.test(namespace)) {
    throw new TypeError(
      `cleCache : namespace invalide « ${namespace} » (attendu : minuscules/chiffres/tirets, ≤ 64 caractères).`,
    );
  }
  return [namespace, ...segments.map((segment) => String(segment))].join(":");
}

/** Entrée stockée : valeur, péremption, coût du calcul initial (mesuré). */
interface Entree<T> {
  valeur: T;
  /** Horodatage (Date.now()) après lequel l'entrée est considérée périmée. */
  expireLe: number;
  /** Durée mesurée du calcul initial (ms) — base de l'estimation latenceGagnée. */
  dureeCalculMs: number;
  /** Taille JSON approximative (octets) — budget mémoire. */
  tailleOctets: number;
}

/** Statistiques honnêtes du cache (source : /api/perf/metrics). */
export interface StatsCache {
  /** Réponses servies depuis le cache (valeur fraîche, relecture directe). */
  hits: number;
  /** Calculs déclenchés (chef de file d'un vol ou re-calcul après TTL/LRU). */
  misses: number;
  /** Appels simultanés JOINTS à un calcul déjà en cours (N-1 économisés). */
  coalesced: number;
  /** Erreurs de calculateur propagées (rien n'est mis en cache en erreur). */
  erreurs: number;
  /** ESTIMATION de la latence évitée (ms) — voir en-tête de module. */
  latenceGagneeMs: number;
  /** Entrées actuellement en cache (≤ entreesMax). */
  taille: number;
  /** Plafond d'entrées configuré. */
  entreesMax: number;
  /** Taux de réussite hits/(hits+misses) — 0 si aucune requête. */
  tauxReussite: number;
}

interface OptionsCache {
  /** Préfixe ajouté à TOUTES les clés de cette instance (isolation). */
  namespace?: string;
  /** Plafond d'entrées (défaut 1 000). */
  entreesMax?: number;
  /** Budget mémoire approximatif en octets (défaut ~25 Mo). */
  octetsMax?: number;
}

/** État interne d'une instance de cache. */
interface EtatCache {
  /** Entrées vivantes — Map ordonnée par récence (LRU par insertion). */
  entrees: Map<string, Entree<unknown>>;
  /** Calculs en vol — promesse partagée par clé (single-flight). */
  enVol: Map<string, Promise<Entree<unknown>>>;
  compteurHits: number;
  compteurMisses: number;
  compteurCoalesced: number;
  compteurErreurs: number;
  latenceGagneeMs: number;
  totalOctets: number;
}

/** Instance exposée par la fabrique — API publique du cache. */
export interface CacheReponses {
  /**
   * Renvoie la valeur fraîche en cache, sinon exécute `calculateur` UNE
   * SEULE fois même si des dizaines d'appels arrivent simultanément
   * (coalescing) — tous reçoivent la même valeur (ou la même erreur).
   *
   * @param cle         Clé namespacée (voir `cleCache`) — inclure TOUT
   *                    paramètre qui influence la réponse (jamais de données
   *                    personnelles hors clé : si la réponse dépend d'un
   *                    utilisateur, son uid fait partie de la clé, ou pas de
   *                    cache du tout).
   * @param ttlMs       Durée de vie en millisecondes (> 0).
   * @param calculateur Fonction de calcul idempotente (jamais mise en cache
   *                    en cas d'erreur : l'exception est partagée aux
   *                    appelants et le prochain appel recalcule).
   */
  obtenirOuCalculer<T>(cle: string, ttlMs: number, calculateur: () => Promise<T>): Promise<T>;
  /** Photographie des compteurs (lecture seule, sans effet de bord). */
  stats(): StatsCache;
  /** Invalide une clé exacte (retourne true si une entrée vivait). */
  invalider(cle: string): boolean;
  /** Purge complète de l'instance (tests, invalidation d'urgence). */
  purger(): void;
}

/**
 * Fabrique de cache isolé (namespace propre, plafonds propres). Le singleton
 * partagé de l'application est `cacheReponses` (export ci-dessous) — la
 * fabrique sert aux tests et aux usages nécessitant une éviction séparée.
 */
export function creerCacheReponses(options: OptionsCache = {}): CacheReponses {
  const entreesMax = Math.max(1, Math.floor(options.entreesMax ?? ENTREES_MAX_DEFAUT));
  const octetsMax = Math.max(1024, Math.floor(options.octetsMax ?? OCTETS_MAX_DEFAUT));
  const prefixe = options.namespace ? `${options.namespace}:` : "";

  const etat: EtatCache = {
    entrees: new Map(),
    enVol: new Map(),
    compteurHits: 0,
    compteurMisses: 0,
    compteurCoalesced: 0,
    compteurErreurs: 0,
    latenceGagneeMs: 0,
    totalOctets: 0,
  };

  function cleInterne(cle: string): string {
    return `${prefixe}${cle}`;
  }

  /** Éviction : périmées d'abord (libère sans perdre de chaudes), puis LRU. */
  function evicterSiBesoin(): void {
    const maintenant = Date.now();
    for (const [cle, entree] of etat.entrees) {
      if (entree.expireLe <= maintenant) {
        etat.entrees.delete(cle);
        etat.totalOctets -= entree.tailleOctets;
      }
    }
    while (etat.entrees.size > entreesMax || etat.totalOctets > octetsMax) {
      const plusAncienne = etat.entrees.keys().next().value;
      if (plusAncienne === undefined) break;
      const entree = etat.entrees.get(plusAncienne);
      etat.entrees.delete(plusAncienne);
      if (entree) etat.totalOctets -= entree.tailleOctets;
    }
  }

  function stocker(cleInterne_: string, entree: Entree<unknown>): void {
    const precedente = etat.entrees.get(cleInterne_);
    if (precedente) etat.totalOctets -= precedente.tailleOctets;
    // Une valeur hors budget ne peut jamais être stockée sans violer le
    // plafond : refus silencieux (l'appelant garde le résultat du calcul,
    // les suivants recalculeront — dégradation propre, jamais d'erreur).
    if (entree.tailleOctets > octetsMax) return;
    etat.entrees.delete(cleInterne_);
    etat.entrees.set(cleInterne_, entree);
    etat.totalOctets += entree.tailleOctets;
    evicterSiBesoin();
  }

  function lireFrais(cleInterne_: string): Entree<unknown> | null {
    const entree = etat.entrees.get(cleInterne_);
    if (!entree) return null;
    if (entree.expireLe <= Date.now()) {
      // Périmée : suppression immédiate — la relecture repartira en calcul
      // (éventuellement coalescé avec le vol déjà démarré).
      etat.entrees.delete(cleInterne_);
      etat.totalOctets -= entree.tailleOctets;
      return null;
    }
    // Récence rafraîchie (Map LRU : delete + set déplace en fin d'ordre).
    etat.entrees.delete(cleInterne_);
    etat.entrees.set(cleInterne_, entree);
    return entree;
  }

  async function demarrerVol<T>(
    cle: string,
    calculateur: () => Promise<T>,
    ttlMs: number,
  ): Promise<T> {
    const debut = performance.now();
    const vol = (async (): Promise<Entree<T>> => {
      const valeur = await calculateur();
      return {
        valeur,
        expireLe: Date.now() + ttlMs,
        dureeCalculMs: Math.max(0, performance.now() - debut),
        tailleOctets: tailleApproximativeOctets(valeur),
      };
    })();

    // Le vol est enregistré AVANT tout await visible de l'extérieur :
    // les appels concurrents qui arrivent pendant le calcul le joignent.
    etat.enVol.set(cle, vol as Promise<Entree<unknown>>);

    try {
      const entree = await vol;
      stocker(cle, entree as Entree<unknown>);
      return entree.valeur;
    } catch (error) {
      etat.compteurErreurs += 1;
      throw error;
    } finally {
      // Le vol est terminé (succès OU échec) : les prochains appelants
      // démarrent un nouveau calcul — jamais de promesse zombie.
      if (etat.enVol.get(cle) === vol) etat.enVol.delete(cle);
    }
  }

  return {
    async obtenirOuCalculer<T>(cle: string, ttlMs: number, calculateur: () => Promise<T>): Promise<T> {
      if (typeof cle !== "string" || cle.length === 0) {
        throw new TypeError("obtenirOuCalculer : clé vide ou non textuelle.");
      }
      const ttl = Math.floor(ttlMs);
      if (!Number.isFinite(ttl) || ttl <= 0) {
        throw new TypeError(
          `obtenirOuCalculer : ttlMs invalide (${String(ttlMs)}) — attendu un entier > 0.`,
        );
      }
      const cle_ = cleInterne(cle);

      // 1) Hit frais : servi depuis la mémoire (récence rafraîchie).
      const frais = lireFrais(cle_);
      if (frais) {
        etat.compteurHits += 1;
        etat.latenceGagneeMs += frais.dureeCalculMs;
        return frais.valeur as T;
      }

      // 2) Single-flight : un calcul identique est déjà en cours — on le
      //    joint (N requêtes simultanées → 1 calcul, N-1 coalescés).
      const vol = etat.enVol.get(cle_);
      if (vol) {
        etat.compteurCoalesced += 1;
        const entree = await vol;
        etat.latenceGagneeMs += entree.dureeCalculMs;
        return entree.valeur as T;
      }

      // 3) Miss : calcul réel (chef de file du vol).
      etat.compteurMisses += 1;
      return demarrerVol(cle_, calculateur, ttl);
    },

    stats(): StatsCache {
      const totaux = etat.compteurHits + etat.compteurMisses;
      return {
        hits: etat.compteurHits,
        misses: etat.compteurMisses,
        coalesced: etat.compteurCoalesced,
        erreurs: etat.compteurErreurs,
        latenceGagneeMs: Math.round(etat.latenceGagneeMs * 100) / 100,
        taille: etat.entrees.size,
        entreesMax,
        tauxReussite: totaux === 0 ? 0 : Math.round((etat.compteurHits / totaux) * 10_000) / 10_000,
      };
    },

    invalider(cle: string): boolean {
      const cle_ = cleInterne(cle);
      const entree = etat.entrees.get(cle_);
      const existed = etat.entrees.delete(cle_);
      if (entree) etat.totalOctets -= entree.tailleOctets;
      return existed;
    },

    purger(): void {
      etat.entrees.clear();
      etat.enVol.clear();
      etat.totalOctets = 0;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Singleton partagé de l'application (attaché à globalThis — survit    */
/* au hot-reload Next en dev ; en serverless il suit le process).       */
/* Les routes utilisent CE singleton avec des clés namespacées via      */
/* cleCache("espace", "v1", …) — les stats globales alimentent          */
/* /api/perf/metrics.                                                   */
/* ------------------------------------------------------------------ */

type GlobalAvecCache = typeof globalThis & { [CLE_GLOBALE]?: CacheReponses };

/** Cache partagé de l'application — plafonds par défaut (1 000 entrées). */
export const cacheReponses: CacheReponses = (() => {
  const global_ = globalThis as GlobalAvecCache;
  if (!global_[CLE_GLOBALE]) {
    global_[CLE_GLOBALE] = creerCacheReponses({ namespace: "g3" });
  }
  return global_[CLE_GLOBALE];
})();

/**
 * @internal Réservé aux tests : réinitialise le singleton partagé
 * (entrées + compteurs) pour repartir d'un état neutre.
 */
export function reinitialiserCacheReponsesPourTests(): void {
  cacheReponses.purger();
}
