/**
 * MÉMOIRE DE DOMAINES GEN3 (demande propriétaire Job 478451 : « pour chaque
 * domaine et chaque capacité un total de 1 Go de données et de datasets — et
 * même pour la mémoire de réflexion ; il doit pouvoir évoluer à mesure qu'il
 * reçoit des données si elles sont implémentées dans sa mémoire ou dans son
 * espace utilisateur via le chat IA et/ou via l'API ; s'il est impossible
 * d'obtenir 1 Go réel par domaine, créer ce qui manque pour obtenir ce Go »).
 *
 * ARCHITECTURE (honnête, mesurable, déterministe) :
 *   - 19 DOMAINES × 7 CAPACITÉS = 133 compartiments, quota cible 1 Go chacun ;
 *   - chaque compartiment rend compte de sa couverture PHYSIQUE RÉELLE
 *     (mesurée sur le disque par scripts/genere-memoire-domaines-it113.ts :
 *     assets HF/Kaggle servis, corpus commis, snapshots SNN, graines) ;
 *   - COMPARTIMENTS CALCULABLES (math, problem_solving, sciences, reasoning,
 *     code_v4, databases) : l'expansion déterministe CRÉE les unités
 *     manquantes à la demande (réponses CALCULÉES par formules exactes sur
 *     des paramètres dérivés de l'index) — le Go est adressable unité par
 *     unité, jamais fabriqué ni pré-stocké ;
 *   - compartiments NON CALCULABLES : aucune donnée fabriquée — leur 1 Go se
 *     remplit par acquisition réelle (fenêtres HF/Kaggle à chaque itération)
 *     et par INGESTION (chat IA / API), comptabilisée en octets réels ;
 *   - INGESTION (evolution) : empreinte 128 bits, déduplication, anneau borné
 *     d'enseignements, sources tracées (chat-ia, api, hf:…, kaggle:…, code:…),
 *     mise à jour du quota du compartiment visé — gen3 évolue à chaque échange ;
 *   - CLASSIFICATEUR de domaine : heuristique mots-clés documentée, mesurable.
 *
 * Module PUR — aucune dépendance Node.
 */

import {
  DATE_MESURE_MEMOIRE,
  MESURES_MEMOIRE,
  type MesureCompartiment,
  PAIRES_MEMOIRE_DOMAINES,
  SOURCES_PAR_DOMAINE,
  TOTAUX_MEMOIRE,
} from "./memoire-domaines-donnees";
import {
  FAMILLES_SYNTHESE,
  type UniteSynthetique,
} from "./memoire-domaines-graines";

/** 1 Go (gigaoctet décimal) — quota cible par compartiment (domaine × capacité). */
export const QUOTA_OCTETS_PAR_DOMAINE = 1_000_000_000;

/** Les 19 domaines canoniques (sélection qualité v4, identiques à
 * scripts/entrainement-ondes-tous-domaines.ts). */
export const DOMAINES_GEN3: readonly string[] = [
  "math", "sciences", "reasoning", "problem_solving", "nlp_comprehension",
  "text_generation", "conversational_memory", "contextual_understanding",
  "intent_recognition", "professions", "databases", "tools", "code_v4",
  "security_v4", "image_analysis", "video_v4", "voice_speech",
  "audio_understanding", "multimodal_v4",
];

/** Les 7 capacités de chaque domaine (modalités de la mission). */
export const CAPACITES_GEN3: readonly string[] = [
  "texte", "image", "audio_parole", "voix", "video", "code", "multimodal",
];

/** Capacités CALCULABLES : familles de graines à réponses calculées. */
export const COMBINAISONS_CALCULABLES: readonly string[] =
  Object.keys(FAMILLES_SYNTHESE);

/** Re-export du registre de sources (datasets HF/Kaggle par domaine). */
export const SOURCES_DATASETS = SOURCES_PAR_DOMAINE;
export type { MesureCompartiment };
export const MESURES = MESURES_MEMOIRE;
export const TOTAUX = TOTAUX_MEMOIRE;
export const DATE_MESURE = DATE_MESURE_MEMOIRE;
export const PAIRES_MEMOIRE = PAIRES_MEMOIRE_DOMAINES;

// ─── EXPANSION DÉTERMINISTE (créer ce qui manque — réponses calculées) ───────

/** Empreinte FNV-1a 128 bits (2 passes semées) — déduplication d'ingestion.
 * Note d'honnêteté : ce n'est pas sha256 (module pur sans dépendance Node) ;
 * le risque de collision documenté reste négligeable pour un anneau borné. */
export function empreinte128(texte: string): string {
  const h1 = fnv1a(texte, 0x811c9dc5);
  const h2 = fnv1a(texte, 0x01000193 ^ 0x9e3779b9);
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function fnv1a(chaine: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < chaine.length; i++) {
    h ^= chaine.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * UNITÉ SYNTHÉTIQUE N : matérialise la N-ième unité d'un compartiment
 * calculable (famille N % nb, paramètres dérivés de N). Déterministe :
 * même N → même unité, partout, toujours. null si le compartiment n'est
 * pas calculable (aucune donnée fabriquée pour lui).
 */
export function uniteSynthetique(
  domaine: string,
  capacite: string,
  index: number,
): UniteSynthetique | null {
  const fams = FAMILLES_SYNTHESE[`${domaine}|${capacite}`];
  if (!fams || fams.length === 0) return null;
  const famille = fams[index % fams.length]!;
  return famille.generer(Math.floor(index / fams.length), index);
}

/** Étendue adressable d'un compartiment calculable : combien d'unités
 * déterministes portent le chemin jusqu'au quota 1 Go. */
export function unitesAdressables(mesure: MesureCompartiment): number {
  if (!mesure.expansionDeterministe || mesure.octetsMoyensParUnite === 0) return 0;
  const reste = QUOTA_OCTETS_PAR_DOMAINE - mesure.octetsReels - mesure.octetsGraine;
  return Math.max(0, Math.floor(reste / mesure.octetsMoyensParUnite));
}

// ─── ÉTAT D'UN COMPARTIMENT (comptabilité honnête) ───────────────────────────

export interface EtatCompartiment {
  readonly cle: string;
  readonly quotaOctets: number;
  readonly octetsReels: number;
  readonly echantillonsAssimiles: number;
  readonly octetsGraine: number;
  readonly octetsInges: number;
  readonly octetsPhysiques: number;
  readonly expansionDeterministe: boolean;
  readonly unitesAdressables: number;
  readonly tauxCouverturePhysique: number;
  readonly ecartRestantOctets: number;
  readonly provenances: readonly string[];
}

// ─── INGESTION (évolution par chat IA / API / fenêtres) ──────────────────────

export const CAPACITE_INGESTION = 1024;
export const SEUIL_JACCARD_MEMORISEE = 0.34;

export type SourceIngestion = "chat-ia" | "api" | string;

export interface Enseignement {
  readonly empreinte: string;
  readonly question: string;
  readonly contenu: string;
  readonly domaine: string;
  readonly capacite: string;
  readonly source: SourceIngestion;
  readonly octets: number;
  readonly horodatage: number;
}

export interface ResultatIngestion {
  readonly accepte: boolean;
  readonly raison: "nouveau" | "doublon" | "domaine-inconnu" | "contenu-vide";
  readonly empreinte: string;
  readonly octets: number;
}

const TOKEN_STOP = new Set([
  "le", "la", "les", "de", "des", "du", "un", "une", "et", "ou", "est", "ce",
  "que", "qui", "quoi", "dans", "sur", "pour", "avec", "au", "aux", "a",
  "d", "l", "sont", "se", "son", "sa", "ses", "ne", "pas", "je", "tu", "il",
  "elle", "on", "nous", "vous", "ils", "elles", "comment", "combien", "quel",
  "quelle", "quels", "quelles", "?", "as", "tu", "tes", "ton", "ta", "toi",
]);

function tokensContenu(texte: string): string[] {
  return texte
    .toLowerCase()
    .split(/[^a-zàâçéèêëîïôûùüÿñæœ0-9_]+/)
    .filter((m) => m.length > 1 && !TOKEN_STOP.has(m));
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

// ─── CLASSIFICATEUR DE DOMAINE (heuristique mots-clés documentée) ────────────

const MOTS_CLES_DOMAINES: Readonly<Record<string, readonly string[]>> = {
  math: ["aire", "équation", "equation", "pourcentage", "périmètre", "perimetre", "calcul", "somme", "produit", "division", "triangle", "km/h", "francs", "%"],
  sciences: ["cellule", "molécule", "molecule", "atome", "gravité", "gravite", "masse volumique", "énerg", "energ", "température", "temperature", "pression", "volume", "physique"],
  reasoning: ["syllogisme", "logique", "déduction", "deduction", "prémisse", "premisse", "énigme", "enigme", "suite", "raisonnement"],
  problem_solving: ["convertis", "conversion", "partage", "résous", "resous", "étape", "etape"],
  nlp_comprehension: ["synonyme", "compréhension", "comprehension", "reformule", "antonyme", "grammaire"],
  text_generation: ["rédige", "redige", "écris", "ecris", "résume", "resume", "rédaction", "redaction"],
  conversational_memory: ["tout à l'heure", "plus tôt", "rappelle", "souvenir", "précédemment", "precedemment", "bonjour", "au revoir", "merci"],
  contextual_understanding: ["contexte", "sous-entendu", "ironie", "implicite", "allusion"],
  intent_recognition: ["intention", "veux-tu", "demande-t"],
  professions: ["médecin", "medecin", "avocat", "ingénieur", "ingenieur", "professeur", "infirmier", "chirurgien", "menuisier"],
  databases: ["sql", "base de données", "base de donnees", "requête", "requete", "jointure", "clé primaire", "cle primaire", "select", "table"],
  tools: ["api", "webhook", "cron", "endpoint", "intégration", "integration"],
  code_v4: ["javascript", "python", "fonction", "variable", "boucle", "algorithme", "compil", "math.floor", "expression"],
  security_v4: ["chiffrement", "pare-feu", "pare-feux", "mot de passe", "hachage", "vulnérabilité", "vulnerabilite", "xss", "csrf", "authentification", "https"],
  image_analysis: ["image", "photo", "pixel", "km1", "km9", "km11", "coco"],
  video_v4: ["vidéo", "video", "fps", "images par seconde", "ucf101", "clip"],
  voice_speech: ["transcription", "voix", "prononciation", "fleurs", "parole"],
  audio_understanding: ["audio", "son", "fréquence", "frequence", "amplitude", "décibel", "decibel", "enregistrement", "wav"],
  multimodal_v4: ["multimodal", "snapshot", "bande", "cortex", "onde", "fenêtre", "fenetre", "asset"],
  // it.150 — domaine « développement web » (demande propriétaire : « l'entraîner
  // sur le dev web ET le DNS »). Termes SPÉCIFIQUES dev web/DNS uniquement :
  // les termes génériques (« fonction », « variable », « javascript »…) restent
  // dans leurs domaines d'origine (code_v4, security_v4 — ordre de priorité :
  // les entrées précédentes gagnent en cas d'égalité de score).
  "developpement-web": [
    "html", "css", "flexbox", "grid-template", "css grid", "media query",
    "responsive", "custom property", "dark mode", "typescript", "node.js",
    "promise", "async", "await", "react", "jsx", "usestate", "useeffect",
    "hook", "next.js", "app router", "server component", "client component",
    "cors", "preflight", "etag", "cdn", "csp", "content-security-policy",
    "clickjacking", "dns", "cname", "enregistrement mx", "mx ", "ttl",
    "dnssec", "spf", "dkim", "dmarc", "nxdomain", "servfail", "zone dns",
    "serveur autoritaire", "résolveur", "resolveur", "propagation dns",
    "dig ", "web vitals", "lighthouse", "lcp", "wcag", "accessibilité",
    "accessibilite", "a11y", "aria-", "sémantique", "semantique",
    "lecteur d'écran",
  ],
};

/** Identifie le domaine d'une requête par recouvrement de mots-clés
 * (heuristique honnête : null si aucun indice — pas de fausse certitude). */
export function identifieDomaine(motif: string): string | null {
  const bas = motif.toLowerCase();
  let meilleur: string | null = null;
  let meilleurScore = 0;
  for (const [domaine, mots] of Object.entries(MOTS_CLES_DOMAINES)) {
    let score = 0;
    for (const m of mots) if (bas.includes(m)) score += 1;
    if (score > meilleurScore) {
      meilleurScore = score;
      meilleur = domaine;
    }
  }
  return meilleur;
}

// ─── DOMAINE « DÉVELOPPEMENT WEB » (it.150) — annexe consultable ────────────

/** Domaine dev web + DNS (demande propriétaire : « l'entraîner sur le dev web
 * ET le DNS »). Enregistré À CÔTÉ des 19 domaines canoniques : la structure
 * mesurée 19 × 7 = 133 compartiments (MESURES_MEMOIRE, TOTAUX) est inchangée ;
 * le domaine dev web vit dans une ANNEXE dédiée, indexée en totalité et
 * consultable par la même voie « mémorisée » (voir repondreIngestion). */
export const DOMAINE_DEVELOPPEMENT_WEB = "developpement-web";

/** Sous-thèmes du domaine — identiques aux corpus commis
 * lib/neural/generation/corpus-dev-web-*.ts (thèmes « developpement-web:X »). */
export const SOUS_THEMES_DEV_WEB = [
  "html-css",
  "js-ts",
  "react-next",
  "http-securite",
  "perf-a11y",
  "dns",
] as const;

export type SousThemeDevWebMemoire = (typeof SOUS_THEMES_DEV_WEB)[number];

/** Unité mémoire dev web (paire question → réponse précise, sous-thème tracé). */
export interface UniteDevWebMemoire {
  readonly motif: string;
  readonly reponse: string;
  readonly sousTheme: string;
}

/** Seuil de consultation de l'annexe (même philosophie que la voie
 * « mémorisée » : pas de faux positif — en dessous, on ne répond pas). */
export const SEUIL_CONSULTATION_DEV_WEB = 0.34;

/** Provenance tracée pour l'ingestion du corpus commis dev web. */
export const SOURCE_CORPUS_DEV_WEB = "corpus-commis:developpement-web";

/** Mots-outils français étendus du tokenizer annexe (les interrogatifs et
 * élisions n'apportent rien au recouvrement sémantique). Accents neutralisés. */
const TOKENS_STOP_DEV_WEB: ReadonlySet<string> = new Set([
  ...TOKEN_STOP,
  "qu", "quest", "cest", "pourquoi", "comment", "peut", "on", "veux",
  "faire", "faut", "sert", "quelle", "quel", "dire", "explique", "dis",
]);

/** Tokenize annexe : casse neutralisée, accents neutralisés, mots-outils écartés. */
function tokensDevWeb(texte: string): string[] {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .split(/[^a-z0-9]+/)
    .filter((m) => m.length > 1 && !TOKENS_STOP_DEV_WEB.has(m));
}

/**
 * ANNEXE DÉVELOPPEMENT WEB : mémoire consultable du domaine « developpement-web »
 * alimentée par les corpus commis (corpus-dev-web-*.ts). Contrairement à
 * l'anneau d'ingestion (1024 enseignements, éviction), l'annexe indexe TOUT
 * le corpus (déduplication par empreinte) — c'est la mémoire de connaissance
 * du domaine, consultable en totalité.
 */
export class MemoireDeveloppementWebGen3 {
  private readonly unites = new Map<string, UniteDevWebMemoire>();
  private readonly ordre: string[] = [];
  private readonly octetsParSousTheme = new Map<string, number>();

  /** Ingestion d'UNE unité (empreinte + déduplication honnête). */
  ingereUnite(unite: UniteDevWebMemoire): ResultatIngestion {
    const motif = unite.motif.trim();
    const reponse = unite.reponse.trim();
    if (motif.length === 0 || reponse.length === 0) {
      return { accepte: false, raison: "contenu-vide", empreinte: "", octets: 0 };
    }
    const empreinte = empreinte128(`${motif}\n${reponse}`);
    if (this.unites.has(empreinte)) {
      return { accepte: false, raison: "doublon", empreinte, octets: motif.length + reponse.length };
    }
    const octets = motif.length + reponse.length;
    const sousTheme = unite.sousTheme.trim().length > 0 ? unite.sousTheme : "dns";
    this.unites.set(empreinte, { motif, reponse, sousTheme });
    this.ordre.push(empreinte);
    this.octetsParSousTheme.set(sousTheme, (this.octetsParSousTheme.get(sousTheme) ?? 0) + octets);
    return { accepte: true, raison: "nouveau", empreinte, octets };
  }

  /** Ingestion d'un corpus complet — résumé honnête (doublons refusés). */
  ingereCorpus(unites: readonly UniteDevWebMemoire[]): {
    acceptees: number;
    doublons: number;
    videes: number;
    octets: number;
    total: number;
  } {
    let acceptees = 0;
    let doublons = 0;
    let videes = 0;
    let octets = 0;
    for (const u of unites) {
      const r = this.ingereUnite(u);
      if (r.accepte) {
        acceptees += 1;
        octets += r.octets;
      } else if (r.raison === "doublon") doublons += 1;
      else videes += 1;
    }
    return { acceptees, doublons, videes, octets, total: unites.length };
  }

  /** Recouvrement d'une requête avec le motif d'une unité : moitié JACCARD
   * des tokens, moitié CONTENANCE des tokens de la question dans le motif —
   * une question courte (« qu'est-ce qu'un CNAME ») doit retrouver l'unité
   * CNAME la plus focalisée sans être diluée par le motif complet. */
  private scoreRequete(requete: string, unite: UniteDevWebMemoire): number {
    const q = new Set(tokensDevWeb(requete));
    if (q.size === 0) return 0;
    const m = new Set(tokensDevWeb(unite.motif));
    let inter = 0;
    for (const x of q) if (m.has(x)) inter += 1;
    if (inter === 0) return 0;
    const jaccard = inter / (q.size + m.size - inter);
    const contenance = inter / q.size;
    return 0.5 * jaccard + 0.5 * contenance;
  }

  /** CONSULTATION : l'unité la plus proche de la question (null sous le
   * seuil — jamais de fausse pertinence). */
  consulte(question: string): UniteDevWebMemoire | null {
    let meilleure: UniteDevWebMemoire | null = null;
    let meilleurScore = 0;
    for (const empreinte of this.ordre) {
      const u = this.unites.get(empreinte)!;
      const score = this.scoreRequete(question, u);
      if (score > meilleurScore) {
        meilleurScore = score;
        meilleure = u;
      }
    }
    if (!meilleure || meilleurScore < SEUIL_CONSULTATION_DEV_WEB) return null;
    return meilleure;
  }

  /** CONSULTATION RICHE : unité principale + jusqu'à 2 compléments DÉJÀ
   * pertinents pour la question (score ≥ moitié du seuil, réponses
   * distinctes, plafond 600 caractères) — la réponse servie porte le
   * contexte utile (TTL, priorités, exemples) sans jamais diluer sous le
   * seuil de pertinence. */
  consulteRiche(question: string): string | null {
    const principale = this.consulte(question);
    if (!principale) return null;
    const morceaux: string[] = [principale.reponse];
    const candidats: Array<{ unite: UniteDevWebMemoire; score: number }> = [];
    const vue = new Set<string>([principale.reponse]);
    for (const empreinte of this.ordre) {
      const u = this.unites.get(empreinte)!;
      if (u === principale || vue.has(u.reponse)) continue;
      const score = this.scoreRequete(question, u);
      if (score >= SEUIL_CONSULTATION_DEV_WEB / 2) {
        candidats.push({ unite: u, score });
      }
    }
    candidats.sort((a, b) => b.score - a.score);
    let octets = principale.reponse.length;
    for (const c of candidats.slice(0, 2)) {
      if (octets + c.unite.reponse.length > 600) break;
      morceaux.push(c.unite.reponse);
      vue.add(c.unite.reponse);
      octets += c.unite.reponse.length;
    }
    return morceaux.join("\n");
  }

  /** Inventaire honnête : total, octets et comptes par sous-thème. */
  inventaire(): { total: number; octets: number; parSousTheme: Record<string, number> } {
    const parSousTheme: Record<string, number> = {};
    for (const u of this.unites.values()) {
      parSousTheme[u.sousTheme] = (parSousTheme[u.sousTheme] ?? 0) + 1;
    }
    const octets = [...this.octetsParSousTheme.values()].reduce((s, v) => s + v, 0);
    return { total: this.unites.size, octets, parSousTheme };
  }

  /** Unités indexées (ordre d'ingestion). */
  litUnites(): readonly UniteDevWebMemoire[] {
    return this.ordre.map((e) => this.unites.get(e)!);
  }
}

/** Convertit les paires des corpus commis (thème « developpement-web:X »)
 * en unités mémoire du domaine — typage structurel, aucune dépendance. */
export function unitesDevWebDepuisPaires(
  paires: readonly { motif: string; reponse: string; theme: string }[],
): UniteDevWebMemoire[] {
  const prefixe = `${DOMAINE_DEVELOPPEMENT_WEB}:`;
  return paires
    .filter((p) => p.theme.startsWith(prefixe))
    .map((p) => ({
      motif: p.motif,
      reponse: p.reponse,
      sousTheme: p.theme.slice(prefixe.length),
    }));
}

// ─── LA MÉMOIRE DE DOMAINES ──────────────────────────────────────────────────

export class MemoireDomainesGen3 {
  /** Annexe dev web (corpus commis indexé en totalité — voir it.150). */
  private readonly annexeDevWeb = new MemoireDeveloppementWebGen3();
  private readonly inges = new Map<string, Enseignement>();
  private readonly ordre: string[] = [];
  private readonly octetsIngesParCle = new Map<string, number>();
  private readonly compteurParSource = new Map<string, number>();

  /**
   * INGESTION (évolution) : empreinte + déduplication + anneau borné +
   * quota du compartiment mis à jour. `question` facultatif : une ingestion
   * sans question est une donnée brute (octets comptés, pas de replay) ;
   * avec question, elle devient un enseignement rejouable (voie « mémorisée »).
   */
  ingere(params: {
    contenu: string;
    question?: string;
    domaine?: string;
    capacite?: string;
    source: SourceIngestion;
  }): ResultatIngestion {
    const contenu = params.contenu.trim();
    if (contenu.length === 0) {
      return { accepte: false, raison: "contenu-vide", empreinte: "", octets: 0 };
    }
    const empreinte = empreinte128(contenu);
    if (this.inges.has(empreinte) && !params.question) {
      return { accepte: false, raison: "doublon", empreinte, octets: contenu.length };
    }
    const domaine = params.domaine ?? identifieDomaine(params.question ?? contenu) ?? "multimodal_v4";
    // it.150 — « developpement-web » est un domaine enregistré (annexe) :
    // l'ingestion chat/API l'accepte comme les 19 domaines canoniques.
    const domainesConnus: readonly string[] = [...DOMAINES_GEN3, DOMAINE_DEVELOPPEMENT_WEB];
    if (!domainesConnus.includes(domaine)) {
      return { accepte: false, raison: "domaine-inconnu", empreinte, octets: contenu.length };
    }
    const capacite = params.capacite ?? "texte";
    if (!CAPACITES_GEN3.includes(capacite)) {
      return { accepte: false, raison: "domaine-inconnu", empreinte, octets: contenu.length };
    }
    const octets = contenu.length;
    const existe = this.inges.get(empreinte);
    if (existe) {
      // même contenu ré-enseigné avec une question (ou l'inverse) : la
      // connaissance est déjà là — compté une seule fois (honnêteté)
      return { accepte: false, raison: "doublon", empreinte, octets: existe.octets };
    }
    const ens: Enseignement = {
      empreinte,
      question: params.question?.trim() ?? "",
      contenu,
      domaine,
      capacite,
      source: params.source,
      octets,
      horodatage: Date.now(),
    };
    this.inges.set(empreinte, ens);
    this.ordre.push(empreinte);
    if (this.ordre.length > CAPACITE_INGESTION) {
      const evincee = this.ordre.splice(0, this.ordre.length - CAPACITE_INGESTION);
      for (const e of evincee) this.inges.delete(e);
    }
    const cle = `${domaine}|${capacite}`;
    this.octetsIngesParCle.set(cle, (this.octetsIngesParCle.get(cle) ?? 0) + octets);
    this.compteurParSource.set(params.source, (this.compteurParSource.get(params.source) ?? 0) + 1);
    return { accepte: true, raison: "nouveau", empreinte, octets };
  }

  /** Annexe dev web du domaine « developpement-web » (ingestion + consultation). */
  memoireDevWeb(): MemoireDeveloppementWebGen3 {
    return this.annexeDevWeb;
  }

  /** INGESTION DU CORPUS DEV WEB (it.150) : alimente l'annexe (index complet,
   * sans éviction) et comptabilise les octets ACCEPTÉS dans le compartiment
   * « developpement-web|texte » (couverture physique honnête, idempotent : un
   * corpus déjà ingéré ne re-compte rien). */
  ingereDevWebCorpus(
    unites: readonly UniteDevWebMemoire[],
    source: SourceIngestion = SOURCE_CORPUS_DEV_WEB,
  ): { acceptees: number; doublons: number; videes: number; octets: number; total: number } {
    const resume = this.annexeDevWeb.ingereCorpus(unites);
    if (resume.octets > 0) {
      const cle = `${DOMAINE_DEVELOPPEMENT_WEB}|texte`;
      this.octetsIngesParCle.set(cle, (this.octetsIngesParCle.get(cle) ?? 0) + resume.octets);
      this.compteurParSource.set(source, (this.compteurParSource.get(source) ?? 0) + resume.acceptees);
    }
    return resume;
  }

  /** Voie « mémorisée » : meilleur enseignement par recouvrement de tokens. */
  repondreIngestion(motif: string): string | null {
    const q = tokensContenu(motif);
    if (q.length === 0) return null;
    let meilleur: Enseignement | null = null;
    let meilleurScore = 0;
    for (const e of this.inges.values()) {
      if (e.question.length === 0) continue;
      const score = jaccard(q, tokensContenu(e.question));
      if (score > meilleurScore) {
        meilleurScore = score;
        meilleur = e;
      }
    }
    if (!meilleur || meilleurScore < SEUIL_JACCARD_MEMORISEE) {
      // it.150 — la voie « mémorisée » consulte aussi l'annexe dev web :
      // le corpus commis « developpement-web » (indexé en totalité) répond
      // quand l'anneau d'ingestion n'a rien de pertinent. Même contrat :
      // null sous le seuil — jamais de fausse pertinence. Version RICHE :
      // unité principale + compléments pertinents (contexte utile).
      const uniteRiche = this.annexeDevWeb.consulteRiche(motif);
      if (uniteRiche !== null) return uniteRiche;
      const unite = this.annexeDevWeb.consulte(motif);
      return unite ? unite.reponse : null;
    }
    return meilleur.contenu;
  }

  /** Classifieur de domaine (délégataire de l'heuristique module) — satisfait
   * le contrat structural SourceMemoireDomaines de la mémoire de réflexion. */
  identifieDomaine(motif: string): string | null {
    return identifieDomaine(motif);
  }

  /** État comptable d'un compartiment (physique mesuré + ingestion courante). */
  etatCompartiment(domaine: string, capacite: string): EtatCompartiment {
    const cle = `${domaine}|${capacite}`;
    const mesure =
      MESURES.find((m) => m.cle === cle) ??
      ({
        cle,
        octetsReels: 0,
        echantillonsAssimiles: 0,
        octetsGraine: 0,
        familles: 0,
        octetsMoyensParUnite: 0,
        expansionDeterministe: false,
        provenances: "",
      } as MesureCompartiment);
    const inges = this.octetsIngesParCle.get(cle) ?? 0;
    const physiques = mesure.octetsReels + mesure.octetsGraine + inges;
    const adressables = unitesAdressables({
      ...mesure,
      octetsReels: mesure.octetsReels + inges,
    });
    return {
      cle,
      quotaOctets: QUOTA_OCTETS_PAR_DOMAINE,
      octetsReels: mesure.octetsReels,
      echantillonsAssimiles: mesure.echantillonsAssimiles,
      octetsGraine: mesure.octetsGraine,
      octetsInges: inges,
      octetsPhysiques: physiques,
      expansionDeterministe: mesure.expansionDeterministe,
      unitesAdressables: adressables,
      tauxCouverturePhysique: physiques / QUOTA_OCTETS_PAR_DOMAINE,
      ecartRestantOctets: Math.max(0, QUOTA_OCTETS_PAR_DOMAINE - physiques),
      provenances: mesure.provenances ? mesure.provenances.split(" ; ") : [],
    };
  }

  /** Sources datasets d'un domaine (registre d'acquisition HF/Kaggle). */
  sourcesDomaine(domaine: string): readonly { nom: string; plateforme: string; reference: string; statut: string; emplacement: string }[] {
    return SOURCES_PAR_DOMAINE[domaine] ?? [];
  }

  /** Statistiques globales honnêtes. */
  statistiques(): {
    compartiments: number;
    compartimentsAvecDonneesReelles: number;
    compartimentsCalculables: number;
    octetsReels: number;
    octetsGraine: number;
    octetsInges: number;
    enseignements: number;
    parSource: Record<string, number>;
    dateMesure: string;
    /** it.150 — inventaire de l'annexe du domaine « developpement-web ». */
    developpementWeb: { total: number; octets: number; parSousTheme: Record<string, number> };
  } {
    const parSource: Record<string, number> = {};
    for (const [s, n] of this.compteurParSource.entries()) parSource[s] = n;
    return {
      compartiments: TOTAUX.compartiments,
      compartimentsAvecDonneesReelles: TOTAUX.compartimentsAvecDonneesReelles,
      compartimentsCalculables: TOTAUX.compartimentsCalculables,
      octetsReels: TOTAUX.octetsReels,
      octetsGraine: TOTAUX.octetsGraine,
      octetsInges: [...this.octetsIngesParCle.values()].reduce((s, v) => s + v, 0),
      enseignements: this.inges.size,
      parSource,
      dateMesure: DATE_MESURE,
      developpementWeb: this.annexeDevWeb.inventaire(),
    };
  }

  /** Anneau d'ingestion (chronologique). */
  litIngestions(): readonly Enseignement[] {
    return this.ordre.map((e) => this.inges.get(e)!);
  }
}
