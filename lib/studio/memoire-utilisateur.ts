import "server-only";

import {
  listJson,
  readJsonIfExists,
  userDir,
  userKey,
  writeJson,
} from "@/lib/storage/user-data-store";
import {
  identifieDomaine as identifieDomaineGen3,
} from "@/lib/neural/generation/memoire-domaines";

import {
  tokensContenu,
  type UniteConnaissance,
} from "./extraction-corpus";

/**
 * MÉMOIRE DE DOMAINE PAR UTILISATEUR — STUDIO D'ENTRAÎNEMENT RÉEL
 * (demande propriétaire : « gen3 doit RÉELLEMENT entraîner : le cerveau doit
 * devenir mesurablement plus performant sur ce domaine »).
 *
 * PRINCIPE HONNÊTE (à lire avant tout usage) :
 *   - ce n'est PAS un apprentissage de poids neuronaux : les poids du SNN
 *     restent inchangés. C'est une MÉMOIRE DE CONNAISSANCE RÉELLE, propre à
 *     chaque utilisateur, ingérée depuis SES ressources (textes, datasets,
 *     URLs), PERSISTÉE dans son stockage permanent (R2 via user-data-store) ;
 *   - le cerveau CONSULTE cette mémoire À LA RÉPONSE — point d'injection :
 *     lib/neural/engine.ts, étage « memoire_utilisateur » de la chaîne de
 *     composition (generate / generateStream / streamDeltas), câblé par
 *     lib/neural/runtime.ts via consulterMemoireUtilisateur() ci-dessous ;
 *   - le contrat de consultation est LE MÊME que memoire-domaines (typage en
 *     canard SourceMemoireDomaines : identifieDomaine + repondreIngestion) —
 *     une mémoire utilisateur peut donc remplacer la mémoire de domaines
 *     partout où le cerveau consulte déjà des enseignements ingérés ;
 *   - la PERFORMANCE est mesurée avant/après (lib/studio/evaluation.ts) :
 *     le score APRÈS ingestion sur les questions du domaine doit être
 *     mesurablement supérieur au score AVANT, sans régression hors domaine.
 *
 * PERSISTANCE : `users/{uid}/studio/memoire/{domaine}.json` (un document par
 * domaine, plafonds honnêtes comptés — jamais de troncature silencieuse).
 * Cache process 60 s (lecture à chaque tour de chat) invalidé à l'ingestion.
 */

// ─── PLAFONDS HONNÊTES ───────────────────────────────────────────────────────

/** Nombre maximal d'unités par mémoire de domaine (au-delà : refusées et comptées). */
export const MAX_UNITES_PAR_MEMOIRE = 150;
/** Budget d'octets (UTF-8) des unités d'une mémoire de domaine — maintient le
 * document JSON sous le plafond d'écriture user-data-store (256 Ko). */
export const MAX_OCTETS_UNITES_MEMOIRE = 180_000;
/** Seuil de réponse (score composé question/mots-clés) — calibré : une
 * reformulation correcte de la question passe, une question sans rapport non. */
export const SEUIL_REPONSE_MEMOIRE = 0.2;
/** Seuil de la voie « mémorisée » — PARITÉ avec memoire-domaines
 * (SEUIL_JACCARD_MEMORISEE). */
export const SEUIL_JACCARD_INGESTION = 0.34;
/** Durée du cache process d'une mémoire chargée. */
export const TTL_CACHE_MEMOIRE_MS = 60_000;

// ─── DOCUMENT PERSISTÉ ───────────────────────────────────────────────────────

/** Document de mémoire d'un domaine (forme persistée R2). */
export interface DocumentMemoireDomaine {
  readonly v: 1;
  readonly uid: string;
  readonly domaine: string;
  readonly unites: UniteConnaissance[];
  readonly misAJour: string;
}

/** Slugifie un domaine libre en segment de clé sûr ([a-z0-9-], ≤ 40). */
export function slugifierDomaine(domaine: string): string {
  const slug = domaine
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length > 0 ? slug : "domaine";
}

// ─── SCORES (mécanique de consultation, déterministe) ────────────────────────

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

/** Recouvrement des tokens du motif avec les mots-clés de l'unité (contenu
 * + question), normalisé par la taille du vocabulaire de l'unité — c'est le
 * RAPPEL du savoir par la requête : une reformulation qui partage les mots
 * du sujet (question OU contenu) passe ; une question sans rapport non. */
function recouvrementMotscles(tokensMotif: string[], unite: UniteConnaissance): number {
  if (unite.motscles.length === 0) return 0;
  const sa = new Set(tokensMotif);
  let inter = 0;
  for (const m of unite.motscles) if (sa.has(m)) inter += 1;
  return inter / unite.motscles.length;
}

/** Score d'appariement d'une question sur une unité (0..1) : le MEILLEUR des
 * deux recouvrements — rappel de la question (Jaccard) OU rappel du
 * vocabulaire (mots-clés contenu+question). Déterministe, calibré par les
 * tests : la question canonique vaut 1, une reformulation correcte ≥ 0.2,
 * une question de contrôle hors domaine vaut 0. */
export function scoreAppariementUnite(motif: string, unite: UniteConnaissance): number {
  const tokens = tokensContenu(motif);
  if (tokens.length === 0) return 0;
  const score = Math.max(
    jaccard(tokens, tokensContenu(unite.question)),
    recouvrementMotscles(tokens, unite),
  );
  return Math.round(score * 10000) / 10000;
}

// ─── RÉSULTATS ───────────────────────────────────────────────────────────────

/** Réponse servie par la mémoire utilisateur à la consultation. */
export interface ReponseMemoireUtilisateur {
  readonly texte: string;
  readonly score: number;
  readonly empreinte: string;
  readonly type: UniteConnaissance["type"];
  readonly question: string;
}

/** Résultat d'une ingestion d'unités dans une mémoire de domaine. */
export interface ResultatIngestionMemoire {
  readonly unitesAjoutees: number;
  readonly doublons: number;
  /** Unités refusées par les plafonds (compte honnête — jamais silencieux). */
  readonly refuseesCap: number;
  readonly totalUnites: number;
  readonly octetsUnites: number;
}

// ─── LA MÉMOIRE DE DOMAINE UTILISATEUR ───────────────────────────────────────

/**
 * Mémoire de domaine d'UN utilisateur : ingère des unités, répond par
 * recouvrement lexical. Même philosophie que MemoireDomainesGen3 (dédup
 * par empreinte, seuils documentés, anneau borné) — mais PERSISTÉE par
 * utilisateur via le dépôt injectable (R2 par défaut).
 */
export class MemoireDomaineUtilisateur {
  private readonly unites: UniteConnaissance[] = [];
  private readonly index: Map<string, UniteConnaissance> = new Map();

  constructor(unites: readonly UniteConnaissance[] = []) {
    for (const u of unites) this.ajouterSansDoublon(u);
  }

  private ajouterSansDoublon(u: UniteConnaissance): boolean {
    if (this.index.has(u.empreinte)) return false;
    this.index.set(u.empreinte, u);
    this.unites.push(u);
    return true;
  }

  /** Unités actuellement portées par la mémoire (ordre d'ingestion). */
  unitesConnues(): readonly UniteConnaissance[] {
    return this.unites;
  }

  /** Octets réels (UTF-8) des contenus portés. */
  tailleOctets(): number {
    return this.unites.reduce((somme, u) => somme + u.octets, 0);
  }

  /**
   * INGESTION : ajoute des unités (dédup par empreinte), respecte les
   * plafonds (nombre + octets) — chaque refus est COMPTÉ, jamais silencieux.
   */
  ingere(
    unites: readonly UniteConnaissance[],
  ): ResultatIngestionMemoire {
    let ajoutees = 0;
    let doublons = 0;
    let refuseesCap = 0;
    for (const u of unites) {
      if (this.index.has(u.empreinte)) {
        doublons += 1;
        continue;
      }
      if (
        this.unites.length >= MAX_UNITES_PAR_MEMOIRE ||
        this.tailleOctets() + u.octets > MAX_OCTETS_UNITES_MEMOIRE
      ) {
        refuseesCap += 1;
        continue;
      }
      if (this.ajouterSansDoublon(u)) ajoutees += 1;
    }
    return {
      unitesAjoutees: ajoutees,
      doublons,
      refuseesCap,
      totalUnites: this.unites.length,
      octetsUnites: this.tailleOctets(),
    };
  }

  /**
   * VOIE RICHE (consultation du cerveau à la réponse) : meilleure unité par
   * score composé (question + mots-clés), au-dessus du seuil documenté.
   */
  repondre(motif: string): ReponseMemoireUtilisateur | null {
    if (motif.trim().length === 0) return null;
    let meilleure: UniteConnaissance | null = null;
    let meilleurScore = 0;
    for (const u of this.unites) {
      const score = scoreAppariementUnite(motif, u);
      if (score > meilleurScore) {
        meilleurScore = score;
        meilleure = u;
      }
    }
    if (!meilleure || meilleurScore < SEUIL_REPONSE_MEMOIRE) return null;
    return {
      texte: meilleure.contenu,
      score: meilleurScore,
      empreinte: meilleure.empreinte,
      type: meilleure.type,
      question: meilleure.question,
    };
  }

  /**
   * VOIE « MÉMORISÉE » (contrat SourceMemoireDomaines — PARITÉ avec
   * memoire-domaines.repondreIngestion : Jaccard de question seul, seuil
   * identique). Satisfait le typage en canard consommé par la mémoire de
   * réflexion du cerveau.
   */
  repondreIngestion(motif: string): string | null {
    const q = tokensContenu(motif);
    if (q.length === 0) return null;
    let meilleur: UniteConnaissance | null = null;
    let meilleurScore = 0;
    for (const u of this.unites) {
      const score = jaccard(q, tokensContenu(u.question));
      if (score > meilleurScore) {
        meilleurScore = score;
        meilleur = u;
      }
    }
    if (!meilleur || meilleurScore < SEUIL_JACCARD_INGESTION) return null;
    return meilleur.contenu;
  }

  /** Classificateur de domaine — délégataire de l'heuristique Gen3 (contrat). */
  identifieDomaine(motif: string): string | null {
    return identifieDomaineGen3(motif);
  }

  /** État comptable honnête de la mémoire. */
  statistiques(): { unites: number; octets: number; parType: Record<string, number> } {
    const parType: Record<string, number> = { qa: 0, fait: 0, code: 0 };
    for (const u of this.unites) parType[u.type] = (parType[u.type] ?? 0) + 1;
    return { unites: this.unites.length, octets: this.tailleOctets(), parType };
  }
}

// ─── DÉPÔT (R2 par défaut, injectable pour les tests) ────────────────────────

/** Dépôt de persistance des mémoires — injectable (tests) / R2 (défaut). */
export interface DepotMemoireUtilisateur {
  /** Lit TOUS les documents de mémoire de l'utilisateur (tous domaines). */
  lireTous(uid: string): Promise<DocumentMemoireDomaine[]>;
  /** Lit le document d'UN domaine (null si absent). */
  lire(uid: string, domaine: string): Promise<DocumentMemoireDomaine | null>;
  /** Écrit (remplace) le document d'un domaine. */
  ecrire(uid: string, doc: DocumentMemoireDomaine): Promise<void>;
}

const depotR2: DepotMemoireUtilisateur = {
  async lireTous(uid) {
    return listJson<DocumentMemoireDomaine>(userDir(uid, "studio", "memoire"), { limit: 24 });
  },
  async lire(uid, domaine) {
    return readJsonIfExists<DocumentMemoireDomaine>(
      userKey(uid, "studio", "memoire", slugifierDomaine(domaine)),
    );
  },
  async ecrire(uid, doc) {
    await writeJson(
      userKey(uid, "studio", "memoire", slugifierDomaine(doc.domaine)),
      doc,
    );
  },
};

let depotActif: DepotMemoireUtilisateur = depotR2;

/** Injecte un dépôt (tests) — usage interne/tests uniquement. */
export function configurerDepotMemoireUtilisateur(depot: DepotMemoireUtilisateur | null): void {
  depotActif = depot ?? depotR2;
}

/** Reconstruit une mémoire de domaine depuis un document persisté. */
export function memoireDepuisDocument(doc: DocumentMemoireDomaine | null): MemoireDomaineUtilisateur {
  const unites = doc && Array.isArray(doc.unites) ? doc.unites : [];
  return new MemoireDomaineUtilisateur(
    unites.filter(
      (u) =>
        u &&
        typeof u.empreinte === "string" &&
        typeof u.question === "string" &&
        typeof u.contenu === "string",
    ),
  );
}

// ─── CACHE PROCESS (consultation à chaque tour — latence bornée) ─────────────

interface EntreeCacheMemoire {
  readonly parDomaine: Map<string, MemoireDomaineUtilisateur>;
  expire: number;
}

const CACHE_MEMOIRES = new Map<string, EntreeCacheMemoire>();
const LIMITE_CACHE_MEMOIRES = 200;

function lireCache(uid: string): EntreeCacheMemoire | null {
  const entree = CACHE_MEMOIRES.get(uid);
  if (!entree) return null;
  if (entree.expire < Date.now()) {
    CACHE_MEMOIRES.delete(uid);
    return null;
  }
  // Rafraîchit la position LRU (Map itère en ordre d'insertion).
  CACHE_MEMOIRES.delete(uid);
  CACHE_MEMOIRES.set(uid, entree);
  return entree;
}

function ecrireCache(uid: string, parDomaine: Map<string, MemoireDomaineUtilisateur>): void {
  if (CACHE_MEMOIRES.size >= LIMITE_CACHE_MEMOIRES && !CACHE_MEMOIRES.has(uid)) {
    const plusAncienne = CACHE_MEMOIRES.keys().next().value;
    if (plusAncienne !== undefined) CACHE_MEMOIRES.delete(plusAncienne);
  }
  CACHE_MEMOIRES.set(uid, { parDomaine, expire: Date.now() + TTL_CACHE_MEMOIRE_MS });
}

/** Invalide le cache process d'un utilisateur (après ingestion) — ou tout. */
export function invaliderCacheMemoireUtilisateur(uid?: string): void {
  if (uid === undefined) CACHE_MEMOIRES.clear();
  else CACHE_MEMOIRES.delete(uid);
}

/** Charge les mémoires de l'utilisateur (cache process 60 s). */
export async function chargerMemoiresUtilisateur(
  uid: string,
): Promise<Map<string, MemoireDomaineUtilisateur>> {
  const cache = lireCache(uid);
  if (cache) return cache.parDomaine;
  const docs = await depotActif.lireTous(uid);
  const parDomaine = new Map<string, MemoireDomaineUtilisateur>();
  for (const doc of docs) {
    if (!doc || typeof doc.domaine !== "string") continue;
    parDomaine.set(doc.domaine, memoireDepuisDocument(doc));
  }
  ecrireCache(uid, parDomaine);
  return parDomaine;
}

/**
 * Consultation CÂBLÉE AU MOTEUR (lib/neural/runtime.ts → engine.ts) :
 * répond depuis la mémoire du compte pour la requête donnée.
 * JAMAIS d'exception : une panne de stockage doit dégrader en « pas de
 * mémoire » (null) — jamais casser une conversation.
 */
export async function consulterMemoireUtilisateur(
  message: string,
  uid: string,
): Promise<{ texte: string; theme: string; score: number } | null> {
  try {
    const messageNet = message.trim();
    if (messageNet.length === 0 || uid.trim().length === 0) return null;
    const parDomaine = await chargerMemoiresUtilisateur(uid);
    let meilleur: { texte: string; domaine: string; score: number } | null = null;
    for (const [domaine, memoire] of parDomaine) {
      const reponse = memoire.repondre(messageNet);
      if (reponse && (!meilleur || reponse.score > meilleur.score)) {
        meilleur = { texte: reponse.texte, domaine, score: reponse.score };
      }
    }
    if (!meilleur) return null;
    return { texte: meilleur.texte, theme: `studio:${meilleur.domaine}`, score: meilleur.score };
  } catch {
    // Stockage indisponible / mémoire corrompue : dégradation honnête.
    return null;
  }
}

// ─── INGESTION PERSISTÉE (appelée par le pipeline du Studio) ─────────────────

/** Clé de stockage du document de mémoire d'un domaine (traçabilité dans
 * le fichier final — la mémoire persistée EST le livrable consultable). */
export function cleMemoireDomaineUtilisateur(uid: string, domaine: string): string {
  return userKey(uid, "studio", "memoire", slugifierDomaine(domaine));
}

/** Lit le document persisté de la mémoire d'un domaine (null si absent). */
export async function lireDocumentMemoireUtilisateur(
  uid: string,
  domaine: string,
): Promise<DocumentMemoireDomaine | null> {
  return depotActif.lire(uid, domaine);
}

/** Ingestion d'unités dans la mémoire de domaine de l'utilisateur + écriture
 * R2 + invalidation du cache. Les plafonds honnêtes s'appliquent. */
export async function ingererUnitesDansMemoireUtilisateur(
  uid: string,
  domaine: string,
  unites: readonly UniteConnaissance[],
): Promise<ResultatIngestionMemoire> {
  const doc = await depotActif.lire(uid, domaine);
  const memoire = memoireDepuisDocument(doc);
  const resultat = memoire.ingere(unites);
  if (resultat.unitesAjoutees > 0 || !doc) {
    await depotActif.ecrire(uid, {
      v: 1,
      uid,
      domaine,
      unites: memoire.unitesConnues().slice(),
      misAJour: new Date().toISOString(),
    });
  }
  invaliderCacheMemoireUtilisateur(uid);
  return resultat;
}
