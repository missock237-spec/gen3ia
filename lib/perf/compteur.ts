/**
 * COMPTEURS DE PERFORMANCE PAR ROUTE — requêtes et latence (p50/p95).
 *
 * RÔLE (Task 9-a — performance/échelle) : compléter le registre SLI global
 * (lib/observability/metrics-registry.ts, classes à cardinalité réduite :
 * chat/api/pages/static) par une granularité PAR ROUTE normalisée, exposée
 * à l'admin via /api/perf/metrics — pour voir QUELLE route ralentit, pas
 * seulement quelle classe.
 *
 * CARDINALITÉ STRICTEMENT BORNÉE (leçon du registre SLI — jamais le chemin
 * brut) :
 *  1. normalisation : la requête d'API est coupée (jamais de query string),
 *     et chaque segment « identifiant » (numérique, UUID/hex, jeton long)
 *     est replié en « :id » — /api/video/projects/<uuid>/render devient
 *     /api/video/projects/:id/render ;
 *  2. plafond : au plus ROUTES_MAX routes distinctes ; au-delà, tout nouveau
 *     chemin tombe dans la série « autre » (pas d'explosion mémoire, pas de
 *     label arbitraire contrôlable par un utilisateur) ;
 *  3. fenêtre : ring buffer de ECHANTILLON_MAX durées PAR route (mémoire
 *     constante).
 *
 * PÉRIMÈTRE DE MESURE (honnêteté — même convention que le registre SLI) :
 * l'observation est branchée dans le middleware, qui mesure le traitement
 * middleware et le statut de SA réponse. Les latences complets de route
 * handler (I/O Firestore, LLM…) ne sont PAS visibles ici : la source de
 * vérité complémentaire reste les logs d'accès nginx et /api/metrics.
 * p50/p95 calculés par RANG le plus proche (nearest-rank) sur l'échantillon
 * courant — estimation empirique, pas une distribution exacte.
 *
 * Module PUR (aucun import) : importable du middleware comme d'une route.
 * Jamais d'exception vers l'appelant : la télémétrie ne perturbe JAMAIS
 * le trafic.
 */

/** Taille du ring buffer de durées par route (mémoire constante). */
const ECHANTILLON_MAX = 500;

/** Nombre maximum de routes suivies distinctement (au-delà → « autre »). */
const ROUTES_MAX = 256;

/** Familles de statut bornées (même grammaire que le registre SLI). */
export type FamilleStatut = "1xx" | "2xx" | "3xx" | "4xx" | "5xx";

/** Clé du singleton sur globalThis (résiste au hot-reload Next en dev). */
const CLE_GLOBALE = "__gen3iaCompteurPerf__";

/** Série repliée au-delà du plafond de routes. */
const ROUTE_REPLI = "autre";

/** Segment identifiant : numérique pur. */
const SEGMENT_NUMERIQUE_RE = /^\d{1,19}$/;
/** Segment identifiant : UUID (v1-v4, canonique ou accolades). */
const SEGMENT_UUID_RE = /^[{([]?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}[}\])]?$|^urn:uuid:[0-9a-fA-F-]{36}$/;
/** Segment identifiant : hex/jeton long (≥ 16 caractères alphanumériques
 *  mélangés sans point — évite de plier les noms de fichiers `sw.js`). */
const SEGMENT_JETON_RE = /^[a-f0-9]{16,}$|^[A-Za-z0-9_-]{20,}$/;

/**
 * Replie les segments « identifiants » d'un chemin en « :id ».
 * Les fichiers (avec extension) et les segments courts restent littéraux :
 * la cardinalité vient des ID, pas des noms de routes.
 */
export function normaliserCheminRoute(chemin: string): string {
  if (typeof chemin !== "string" || chemin.length === 0) return "/";
  // Query string et fragment : JAMAIS comptés (cardinalité arbitraire).
  const sansQuery = chemin.split(/[?#]/, 1)[0] ?? chemin;
  const segments = sansQuery.split("/").filter((segment) => segment.length > 0);
  const replies = segments.map((segment) => {
    if (SEGMENT_NUMERIQUE_RE.test(segment)) return ":id";
    if (SEGMENT_UUID_RE.test(segment)) return ":id";
    if (SEGMENT_JETON_RE.test(segment)) return ":id";
    return segment;
  });
  return `/${replies.join("/")}`;
}

/** État persistant (attaché à globalThis). */
interface EtatCompteur {
  creeLe: number;
  /** Route → famille de statut → compteur. */
  requetes: Map<string, Map<FamilleStatut, number>>;
  /** Route → ring buffer des durées (ms) observées. */
  durees: Map<string, number[]>;
}

type GlobalAvecCompteur = typeof globalThis & { [CLE_GLOBALE]?: EtatCompteur };

function obtenirEtat(): EtatCompteur {
  const global_ = globalThis as GlobalAvecCompteur;
  let etat = global_[CLE_GLOBALE];
  if (!etat) {
    etat = { creeLe: Date.now(), requetes: new Map(), durees: new Map() };
    global_[CLE_GLOBALE] = etat;
  }
  return etat;
}

/** Famille de statut (« 503 » → « 5xx ») — hors bornes rangée en 5xx. */
function familleStatut(statut: number): FamilleStatut {
  const centaine = Math.floor(statut / 100);
  if (centaine >= 1 && centaine <= 5) return `${centaine}xx` as FamilleStatut;
  return "5xx";
}

/**
 * Enregistre une requête observée (compteur + durée) pour une ROUTE
 * normalisée. Silencieux par construction : un échec de mesure ne casse
 * JAMAIS la requête ; durées négatives/non finies bornées à 0.
 */
export function noterRequetePerf(chemin: string, statut: number, dureeMs: number): void {
  try {
    const etat = obtenirEtat();
    let route = normaliserCheminRoute(chemin);

    // Plafond de cardinalité : au-delà de ROUTES_MAX routes distinctes,
    // les NOUVEAUX chemins se fondent dans « autre » (jamais d'explosion
    // mémoire, jamais de label arbitraire contrôlable par un utilisateur).
    if (route !== ROUTE_REPLI && !etat.requetes.has(route) && etat.requetes.size >= ROUTES_MAX) {
      route = ROUTE_REPLI;
    }
    const famille = familleStatut(statut);

    let compteurRoute = etat.requetes.get(route);
    if (!compteurRoute) {
      compteurRoute = new Map();
      etat.requetes.set(route, compteurRoute);
    }
    compteurRoute.set(famille, (compteurRoute.get(famille) ?? 0) + 1);

    let buffer = etat.durees.get(route);
    if (!buffer) {
      buffer = [];
      etat.durees.set(route, buffer);
    }
    buffer.push(Number.isFinite(dureeMs) ? Math.max(0, dureeMs) : 0);
    if (buffer.length > ECHANTILLON_MAX) buffer.shift();
  } catch {
    // Télémétrie silencieuse — volontairement vide.
  }
}

/** Ligne exposée par l'instantané (une par route suivie). */
export interface LignePerfRoute {
  route: string;
  total: number;
  parStatut: Partial<Record<FamilleStatut, number>>;
  /** Médiane (ms) de l'échantillon courant — rang le plus proche. */
  p50Ms: number;
  /** 95e centile (ms) de l'échantillon courant — rang le plus proche. */
  p95Ms: number;
  moyenneMs: number;
  /** Taille de l'échantillon courant (≤ ECHANTILLON_MAX). */
  echantillons: number;
}

/** Percentile par rang le plus proche (nearest-rank, échantillon trié). */
function percentile(trie: number[], p: number): number {
  if (trie.length === 0) return 0;
  const rang = Math.max(1, Math.ceil((p / 100) * trie.length));
  return trie[Math.min(rang, trie.length) - 1] ?? trie[trie.length - 1];
}

/** Photographie complète (source de /api/perf/metrics). */
export function instantaneCompteursPerf(): Array<LignePerfRoute> {
  const etat = obtenirEtat();
  const lignes: Array<LignePerfRoute> = [];

  for (const [route, compteur] of etat.requetes) {
    const parStatut: Partial<Record<FamilleStatut, number>> = {};
    let total = 0;
    for (const [famille, nombre] of compteur) {
      parStatut[famille] = nombre;
      total += nombre;
    }

    const buffer = etat.durees.get(route) ?? [];
    const trie = [...buffer].sort((a, b) => a - b);
    const somme = trie.reduce((acc, valeur) => acc + valeur, 0);

    lignes.push({
      route,
      total,
      parStatut,
      p50Ms: percentile(trie, 50),
      p95Ms: percentile(trie, 95),
      moyenneMs: trie.length === 0 ? 0 : Math.round((somme / trie.length) * 100) / 100,
      echantillons: trie.length,
    });
  }

  // Sortie déterministe : routes triées alphabétiquement (diffs stables).
  lignes.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
  return lignes;
}

/** Date de création du registre (≈ démarrage du process, à la 1re mesure). */
export function demarrageCompteursPerf(): number {
  return obtenirEtat().creeLe;
}

/**
 * @internal Réservé aux tests : réinitialise le registre (routes + durées)
 * pour repartir d'un état neutre entre les scénarios.
 */
export function reinitialiserCompteursPourTests(): void {
  const etat = obtenirEtat();
  etat.requetes.clear();
  etat.durees.clear();
  etat.creeLe = Date.now();
}
