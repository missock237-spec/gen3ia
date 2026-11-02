/**
 * CORTEX LANGAGIER GEN3 — le noyau de génération de langage du moteur
 * neuronal. C'est le module qui rend Gen3ia réellement conversationnelle.
 *
 * PRINCIPE (honnêteté d'architecture) : le SNN Gen3 n'est pas un modèle de
 * langage statistique et n'improvisera jamais de contenu. Le langage de
 * l'IA vient donc d'un CORPUS APPRIS : des paires { motif, réponse }
 * (corpus d'amorçage intégré + paires personnalisées apprises via le
 * Studio d'entraînement). Le cortex :
 *  1. INDEXE chaque paire sur ses tokens normalisés (index inversé) ;
 *  2. COTE la requête contre les motifs (recouvrement pondéré IDF,
 *     normalisation cosinus, bonus de personnalisation, poids d'usage) ;
 *  3. COMPOSE la réponse de la meilleure paire au-dessus du seuil — ou
 *     renvoie null (le moteur retombe alors sur la composition
 *     conversationnelle par intention du décodeur) ;
 *  4. RENFORCE l'usage : chaque rappel réussi augmente le poids de la
 *     paire (plasticité d'usage, plafonnée) — la connaissance utile
 *     remonte plus vite ;
 *  5. UTILISE LE CONTEXTE : les tokens du tour précédent de la
 *     conversation (hippocampe) participent au score à poids réduit —
 *     c'est le traitement des reprises courtes (« et toi ? »).
 *
 * Déterminisme total : mêmes entrées → même réponse (hash de sélection,
 * aucun hasard). État exportable/importable pour la persistance du
 * cerveau (v2).
 *
 * Module PUR — aucune dépendance Node.
 */

import { tokenize } from "../encoding/text-encoder";
import type { PaireLangage } from "./corpus";

/**
 * it.86-b — GARDE DE COHÉRENCE NUMÉRIQUE (anti-désinformation, mesurée) :
 * une paire dont la réponse CALCULE (« a + b = c ») ne peut répondre que si
 * ses opérandes figurent dans la requête — sinon elle répond à une AUTRE
 * question avec des nombres figés. Mesure motrice (interrogatoire
 * utilisateur réel, tick 05:10) : « 4435 … et 29 le soir » recevait
 * « Somme : 3 + 2 = 5 » d'une paire consolidée lexicalement voisine à
 * petites valeurs. Une réponse sans équation explicite est neutre.
 */
function equationCoherente(requete: string, reponse: string): boolean {
  const equations = [
    ...reponse.matchAll(
      /(\d[\d\u202f\u00a0 .,]*)\s*([+\-×*x/−])\s*(\d[\d\u202f\u00a0 .,]*)\s*(?:=\s*(\d[\d\u202f\u00a0 .,]*))?/g,
    ),
  ];
  if (equations.length === 0) return true; // pas de calcul explicite → neutre
  const connus = new Set(
    requete.replace(/[\u202f\u00a0 ]/g, "").match(/\d+/g) ?? [],
  );
  const norm = (s: string): string => s.replace(/[\u202f\u00a0 .,]/g, "");
  for (const eq of equations) {
    const a = norm(eq[1]);
    const b = norm(eq[3]);
    // RÈGLE DU PAS-À-PAS LÉGITIME : chaque équation consomme au moins un
    // nombre DE LA QUESTION ou un RÉSULTAT PRÉCÉDENT de la même réponse
    // (valeurs intermédiaires : « 3 × 24 = 72 » puis « 72 × 400 = 28 800 »).
    // Deux opérandes inconnus = calcul hors-sol = paire d'une autre question.
    if (!connus.has(a) && !connus.has(b)) return false;
    const c = eq[4] ? norm(eq[4]) : null;
    if (c) connus.add(c); // le résultat alimente la chaîne
  }
  return true;
}

/** Seuil d'appariement (score cosinus pondéré IDF) au-delà duquel une paire répond. */
export const SEUIL_APPARIEMENT = 0.34;

/**
 * it.85-r — COUVERTURE MINIMALE DE LA PAIRE (calibrée par mesure) : pour
 * une requête riche (≥ 4 tokens actifs), la paire candidate doit présenter
 * au moins 45 % de ses tokens (hors nombres) dans la requête. Mesure
 * motrice : « Bravo, tu as vraiment perfectionné ton talent… » → paire
 * remerciement scoreait 8,53 avec UN token partagé sur ~6 (couverture
 * 0,25 → rejetée) ; l'appariement exact 5,67 conserve une couverture
 * ~1,0 → passe inchangée.
 */
export const COUVERTURE_PAIRE_MIN = 0.45;

/**
 * it.85-r (2e calibrage) — couverture minimale de la REQUÊTE : la part des
 * tokens actifs de la requête que la paire porte. Tuée par mesure : le
 * faux match « Bravo… » portait 2 tokens sur 9 actifs (0,22 < 0,25).
 */
export const COUVERTURE_REQUETE_MIN = 0.25;

/**
 * BARRE DE QUALITÉ DE BASE — un score normalisé en dessous de cette barre
 * ne bénéficie PAS de la plasticité d'usage (poidsUsage) : une paire très
 * utilisée ne peut plus faire passer une correspondance médiocre au-dessus
 * du seuil (bug réel : une paire apprise hors-sujet répondait à des
 * questions sans rapport parce que son poids d'usage la propulsait).
 */
export const BARRE_BASE_USAGE = SEUIL_APPARIEMENT;

/** Marqueurs de langue FR/EN (pure, testée) — garde de cohérence : une paire
 *  ne répond que dans la langue de la requête (hors sous-ensemble exact),
 *  sinon le cortex serait silencieux OU délivrerait une réponse hors-sujet
 *  traduite d'un autre corpus appris. */
const MARQUEURS_FR_RE =
  /\b(le|la|les|un|une|des|du|de|d'|l'|et|ou|est|sont|que|qui|quoi|comment|pourquoi|quand|combien|je|tu|il|elle|nous|vous|on|dans|sur|pour|avec|pas|plus|moins|c'est|qu'est)\b/i;
const MARQUEURS_EN_RE =
  /\b(the|a|an|is|are|was|were|there|that|this|of|to|and|or|with|for|you|your|our|we|i|it|its|can|will|would|yes|no|not|please|how|what|why|when)\b/i;
const ACCENTS_FR_RE = /[éèêëàâçîïôûùü]/i;
/** Écritures NON-LATINES (arabe, cyrillique, CJK, devanagari, hébreu…) :
 *  une paire apprise dans une autre écriture ne peut pas répondre à une
 *  requête latine — bug réel : une paire ARABE (dataset commercial appris
 *  par l'auto-apprentissage) répondait « عندنا آخر قطعة مقاس 38… » à une
 *  question de calcul français, matchée sur le seul chiffre « 38 ». */
const NON_LATIN_RE = /[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;

/** Détecte la langue dominante d'un texte : "fr" | "en" | "autre" | null.
 *  "autre" = écriture non latine (rejet systématique hors sous-ensemble). */
export function détecterLangue(texte: string): "fr" | "en" | "autre" | null {
  if (NON_LATIN_RE.test(texte)) return "autre";
  const fr = (texte.match(MARQUEURS_FR_RE)?.length ?? 0) + (ACCENTS_FR_RE.test(texte) ? 2 : 0);
  const en = texte.match(MARQUEURS_EN_RE)?.length ?? 0;
  if (fr === 0 && en === 0) return null;
  if (fr > en) return "fr";
  if (en > fr) return "en";
  return null;
}

/** Bonus multiplicatif des paires personnalisées (connaissances enseignées). */
export const BONUS_PERSONNALISEE = 1.25;

/**
 * Bonus de sous-ensemble : quand la totalité des tokens informatifs du motif
 * est contenue dans la requête, l'utilisateur a posé exactement cette question
 * (peut-être avec des mots en plus) — signal fort, bonus déterministe.
 */
export const BONUS_SOUS_ENSEMBLE = 1.6;

/** it.86 — BONUS DE MOTIF EXACT : une paire apprise que l'on repose
 * TEXTUELLEMENT (même motif normalisé) est la réponse attendue — son score
 * reçoit un multiplicateur dominant. Mesure : sans ce bonus, une paire
 * corrective exacte n'obtenait que 49 % de réparation dans un index chargé
 * de paires voisines (20 000 paires mathématiques partagent « francs »,
 * « cartons », « achète »…) ; avec, la réparation mesurée est de 100 %. */
export const BONUS_MOTIF_EXACT = 3.5;

/** Poids des tokens du tour précédent (contexte anaphorique). */
export const POIDS_CONTEXTE = 0.35;

/**
 * Décroissance du poids de contexte pour les tours plus anciens : le tour
 * N-1 pèse POIDS_CONTEXTE, le tour N-2 pèse POIDS_CONTEXTE × DÉCROISSANCE
 * (0.57), le tour N-3 pèse POIDS_CONTEXTE × DÉCROISSANCE² (0.33)…
 * Fenêtre utile bornée à 3 tours (au-delà le signal lexical est dilué).
 */
export const DÉCROISSANCE_CONTEXTE = 0.57;
export const MAX_TOURS_CONTEXTE = 3;

/** Facteur d'affaiblissement d'une paire signalée inutile (feedback 👎). */
export const FACTEUR_AFFAIBLISSEMENT = 0.85;

/** Plancher du poids d'usage (une paire affaiblie reste rappelable). */
export const POIDS_USAGE_MIN = 0.6;

/** Poids d'usage initial d'une paire. */
export const POIDS_USAGE_INITIAL = 1.0;

/** Gain de plasticité d'usage par rappel réussi. */
export const GAIN_USAGE = 0.05;

/** Plafond du poids d'usage (la plasticité ne s'emballe pas). */
export const POIDS_USAGE_MAX = 2.0;

/** Nombre maximal de paires personnalisées (budget mémoire du cortex).
 *  Élargi (directive « entraînement autonome à grande échelle ») : l'absorption
 *  continue depuis les hubs (Hugging Face + Kaggle) doit pouvoir stocker les
 *  connaissances acquises — ~20 000 paires ≈ quelques Mo en RAM, sans risque
 *  pour le VPS 2 Go. */
export const MAX_PAIRES_PERSONNALISEES = 20_000;

/**
 * STOPWORDS (FR + EN) : mots fonctionnels sans valeur discriminante. Ils sont
 * exclus du scoring — sans ce filtre, l'IDF du corpus les sur-privilégie
 * (rarement présents dans les motifs courts) et des requêtes sans rapport
 * peuvent matcher par leurs seuls articles (« des », « la »…).
 */
const STOPWORDS = new Set([
  // Français
  "le", "la", "les", "un", "une", "des", "de", "du",
  "et", "ou", "au", "aux", "ce", "cet", "cette", "ces",
  "ne", "pas", "plus", "pour", "par", "avec", "dans", "sur",
  "en", "y", "a", "se", "sa", "son", "ses", "leur", "leurs",
  "nous", "vous", "je", "me", "te", "ils", "elles", "on",
  "mais", "comme", "tout", "tous", "toute", "toutes", "bien",
  "peut", "veux", "vais", "va", "fait", "fais", "est", "sont",
  "the", "an", "of", "to", "and", "or", "in", "on", "for", "with",
  "is", "are", "be", "do", "you", "your", "it", "at", "this", "that",
]);

/** Filtre les tokens informatifs (hors stopwords). */
function tokensInformatifs(tokens: string[]): string[] {
  return tokens.filter((t) => !STOPWORDS.has(t));
}

/**
 * it.85-r — RACINISATION LÉGÈRE SYMÉTRIQUE (re-test production 18:10) :
 * « chats » et « chat », « animaux » et « animal » étaient des tokens
 * DISTINCTS — la couverture s'effondrait sur les reformulations au
 * pluriel. Racines appliquées UNE FOIS, symétriquement (requête ET
 * paires) : ce qui compte est la cohérence requête↔paire, pas la
 * linguistique. Seuils de longueur pour ne jamais écraser les mots
 * courts (sel, vis, as). « aux → al » couvre les pluriels irréguliers
 * courants (animaux→animal, chevaux→cheval, journaux→journal) ; les
 * verbes récurrents sont alignés (-ent→-e, -ez→-e, -er→-e : regarder,
 * achète, achetez partagent la même racine que acheter).
 * Persistance : `cleMotif` reste calculée sur les tokens BRUTS — les
 * clés de motifs et poids d'usage déjà persistés restent valides.
 */
export function racineLegere(token: string): string {
  if (token.length >= 7 && token.endsWith("aux")) return token.slice(0, -2) + "l";
  if (token.length >= 5 && token.endsWith("x")) return token.slice(0, -1);
  if (token.length >= 4 && token.endsWith("s")) return token.slice(0, -1);
  if (token.length >= 7 && token.endsWith("ent")) return token.slice(0, -2);
  if (token.length >= 6 && token.endsWith("ez")) return token.slice(0, -1);
  // « achète »→achete, « achètez »→achete, « acheter »→achete : converger
  // vers la même racine que les formes conjuguées (règle -er → -e).
  if (token.length >= 6 && token.endsWith("er")) return token.slice(0, -1);
  return token;
}

/** Paire interne indexée. */
interface PaireIndexee {
  motif: string;
  reponse: string;
  theme: string;
  /** Clé de motif normalisée (détection du reposé textuel exact). */
  cle: string;
  /** Tokens normalisés du motif (dédupliqués). */
  tokens: Set<string>;
  /** Liste ordonnée (pour la normalisation). */
  tailleTokens: number;
  /** Paire enseignée par l'utilisateur (Studio d'entraînement). */
  personnalisee: boolean;
  /** Provenance réelle — les paires « mesure » ne répondent JAMAIS au chat. */
  provenance: ProvenancePaire;
  /** Poids d'usage (plasticité de rappel). */
  poidsUsage: number;
}

/** Réponse composée par le cortex. */
export interface ReponseLangage {
  /** Texte de la réponse (réponse apprise, verbatim). */
  texte: string;
  /** Thème de la paire retrouvée. */
  theme: string;
  /** Score d'appariement normalisé (0..1+). */
  score: number;
  /** Provenance : corpus d'amorçage, paire personnalisée, ou contexte (reprise). */
  source: "corpus" | "personnalisee" | "contexte";
  /** Clé de motif de la paire gagnante — sert à la plasticité par feedback. */
  cle?: string;
}

/**
 * Provenance d'une paire indexée :
 *  - "corpus"       : socle d'amorçage canonique (réponda au chat) ;
 *  - "personnalisee": enseignée EXPLICITEMENT par un utilisateur (brain.train,
 *    Studio — répond au chat) ;
 *  - "mesure"       : matière d'auto-apprentissage hub (thème « hub:… ») —
 *    apprise pour la MESURE DE RÉTENTION du Studio d'entraînement, JAMAIS
 *    utilisée pour répondre dans la conversation. Bug réel : des paires
 *    commerciales/arabes hub répondaient hors-sujet à tous les comptes.
 */
export type ProvenancePaire = "corpus" | "personnalisee" | "mesure";

/** Contexte conversationnel fourni par le moteur (hippocampe). */
export interface ContexteLangage {
  /** Message utilisateur précédent (pour les reprises courtes). */
  messagePrecedent?: string;
  /** Réponse de l'IA précédente (pour éviter les répétitions totales). */
  reponsePrecedente?: string;
  /**
   * Historique étendu (tours antérieurs, du plus récent au plus ancien).
   * Permet au cortex de résoudre les reprises sur 2-3 tours avec décroissance
   * (DÉCROISSANCE_CONTEXTE) — la fenêtre longue reste gérée par le
   * contexte LLM (buildContextWindow), ici on n'alimente que le score lexical.
   */
  historique?: { message: string; reponse?: string }[];
}

/** Statistiques d'apprentissage retournées par apprendre(). */
export interface StatsApprentissageLangage {
  /** Paires ajoutées (nouvelles). */
  pairesAjoutees: number;
  /** Paires ignorées (doublons de motif déjà connus). */
  pairesDoublons: number;
  /** Taille du vocabulaire indexé (tokens distincts). */
  vocabulaire: number;
  /** Nombre total de paires indexées après apprentissage. */
  totalPaires: number;
}

/** État exportable du cortex (persistance cerveau v2). */
export interface EtatLangage {
  /** Paires personnalisées (enseignées) — le corpus d'amorçage est réappris au démarrage. */
  pairesPersonnalisees: PaireLangage[];
  /** Poids d'usage par hash de motif (motif → poids). */
  poidsUsage: Record<string, number>;
}

/** Motif normalisé servant de clé (tokens triés + joints). */
function cleMotif(motif: string): string {
  return [...new Set(tokenize(motif))].sort().join(" ");
}

/**
 * CORTEX LANGAGIER GEN3.
 * Instancié une fois par le runtime neuronal (singleton) ; l'apprentissage
 * du corpus d'amorçage est refait à chaque démarrage (rapide, pur) et les
 * paires personnalisées sont restaurées depuis la persistance.
 */
export class CortexLangagierGen3 {
  private readonly paires: PaireIndexee[] = [];
  /** Index inversé token → indices de paires. */
  private readonly indexTokens = new Map<string, number[]>();
  /** Clés de motifs déjà apprises (anti-doublon). */
  private readonly clesConnues = new Set<string>();
  /** Clé de motif → poids d'usage (persistance). */
  private readonly poidsParCle = new Map<string, number>();

  /**
   * Apprend des paires conversationnelles. Idempotent (les doublons de motif
   * sont ignorés, leur poids d'usage est conservé).
   */
  apprendre(
    paires: readonly PaireLangage[],
    opts: { personnalisees?: boolean; pourMesure?: boolean } = {},
  ): StatsApprentissageLangage {
    const personnalisees = opts.personnalisees ?? false;
    let ajoutees = 0;
    let doublons = 0;

    for (const paire of paires) {
      if (!paire.motif.trim() || !paire.reponse.trim()) continue;

      const cle = cleMotif(paire.motif);
      if (this.clesConnues.has(cle)) {
        doublons += 1;
        continue;
      }

      // Provenance : les paires hub (thème « hub:… ») sont toujours de la
      // MATIÈRE DE MESURE — même restaurées d'un cerveau persisté ancien où
      // elles étaient rangées comme personnalisées. Idem pour toute paire
      // « personnalisée » en écriture NON LATINE (échanges consolidés
      // arabes/cyrilliques… — neutralisés sans suppression) et pour les
      // paires « consolide » (consolidation AUTOMATIQUE d'échanges, globale
      // au serveur : jamais un savoir enseigné explicitement par un
      // utilisateur — les thèmes légitimes du chat restent
      // « enseigné-chat » et « abréviations »).
      const langueReponse = personnalisees ? détecterLangue(paire.reponse) : null;
      const horsPlateforme = personnalisees && langueReponse === "autre";
      const consolidationAuto = personnalisees && paire.theme === "consolide";
      const provenance: ProvenancePaire =
        opts.pourMesure ||
        paire.theme.startsWith("hub:") ||
        horsPlateforme ||
        consolidationAuto
          ? "mesure"
          : personnalisees
            ? "personnalisee"
            : "corpus";

      // Budget de paires personnalisées (le corpus d'amorçage n'y compte pas).
      if (
        personnalisees &&
        provenance === "personnalisee" &&
        this.compterPersonnalisees() >= MAX_PAIRES_PERSONNALISEES
      ) {
        break;
      }

      const tokens = new Set(
        tokensInformatifs(tokenize(paire.motif)).map(racineLegere),
      );
      if (tokens.size === 0) {
        // Motif 100 % stopwords : non indexable, jamais rappelable — ignoré.
        doublons += 1;
        continue;
      }
      const index: PaireIndexee = {
        motif: paire.motif.trim(),
        reponse: paire.reponse.trim(),
        theme: paire.theme,
        cle,
        tokens,
        tailleTokens: Math.max(1, tokens.size),
        personnalisee: personnalisees && provenance !== "mesure",
        provenance,
        poidsUsage: this.poidsParCle.get(cle) ?? POIDS_USAGE_INITIAL,
      };

      const indice = this.paires.length;
      this.paires.push(index);
      this.clesConnues.add(cle);
      for (const token of tokens) {
        let liste = this.indexTokens.get(token);
        if (!liste) {
          liste = [];
          this.indexTokens.set(token, liste);
        }
        liste.push(indice);
      }
      ajoutees += 1;
    }

    return {
      pairesAjoutees: ajoutees,
      pairesDoublons: doublons,
      vocabulaire: this.indexTokens.size,
      totalPaires: this.paires.length,
    };
  }

  /**
   * Recherche la meilleure paire pour la requête. Retourne null sous le
   * seuil (le moteur composera alors depuis l'intention détectée).
   *
   * Score = Σ_tokens(idf × poidsContexte) / sqrt(|req| × |paire|), où :
   *  - idf(t) = ln(1 + N/df(t)) — les tokens rares pèsent plus lourd ;
   *  - les tokens issus du tour précédent pèsent POIDS_CONTEXTE (reprises) ;
   *  - les paires personnalisées reçoivent BONUS_PERSONNALISEE ;
   *  - le poids d'usage (plasticité) multiplie le score final (plafonné).
   */
  repondre(
    requete: string,
    contexte: ContexteLangage = {},
    opts: { inclureMesure?: boolean } = {},
  ): ReponseLangage | null {
    if (this.paires.length === 0) return null;

    // it.85-r : racinisation légère symétrique — la requête est comparée
    // aux paires sur des racines (pluriels/verbes alignés), jamais sur
    // des formes fléchies divergentes.
    const tokensRequete = [
      ...new Set(tokensInformatifs([...new Set(tokenize(requete))]).map(racineLegere)),
    ];
    if (tokensRequete.length === 0) return null;

    // Tokens de contexte (reprises) : uniquement ceux absents de la requête.
    const tokensContexte = contexte.messagePrecedent
      ? [
          ...new Set(
            tokensInformatifs([...new Set(tokenize(contexte.messagePrecedent))])
              .map(racineLegere)
              .filter((t) => !tokensRequete.includes(t)),
          ),
        ]
      : [];

    // Contexte étendu : jusqu'à MAX_TOURS_CONTEXTE tours antérieurs, chacun
    // pesant POIDS_CONTEXTE × DÉCROISSANCE_CONTEXTE^age (décroissance géométrique).
    const poidsHistorique = new Map<string, number>();
    if (Array.isArray(contexte.historique)) {
      const déjàVus = new Set([...tokensRequete, ...tokensContexte]);
      contexte.historique
        .slice(0, MAX_TOURS_CONTEXTE)
        .forEach((tour, position) => {
          if (!tour?.message) return;
          const poids = POIDS_CONTEXTE * Math.pow(DÉCROISSANCE_CONTEXTE, position + 1);
          if (poids < 0.05) return;
          for (const token of tokensInformatifs([
            ...new Set(tokenize(tour.message)),
          ]).map(racineLegere)) {
            if (déjàVus.has(token)) continue;
            déjàVus.add(token);
            poidsHistorique.set(token, poids);
          }
        });
    }

    const totalPaires = this.paires.length;

    // Accumulateur paire → score brut.
    const scores = new Map<number, number>();
    const cumulLongueur = new Map<number, { req: number; ctx: number }>();

    const accumuler = (token: string, poids: number, contexteTour: boolean): void => {
      const candidats = this.indexTokens.get(token);
      if (!candidats) return;
      const idf = Math.log(1 + totalPaires / candidats.length);
      for (const indice of candidats) {
        scores.set(indice, (scores.get(indice) ?? 0) + idf * poids);
        const cumul = cumulLongueur.get(indice) ?? { req: 0, ctx: 0 };
        if (contexteTour) cumul.ctx += 1;
        else cumul.req += 1;
        cumulLongueur.set(indice, cumul);
      }
    };

    for (const token of tokensRequete) accumuler(token, 1.0, false);
    for (const token of tokensContexte) accumuler(token, POIDS_CONTEXTE, true);
    // Contexte étendu (tours N-2, N-3…) : poids décroissant, compté comme contexte.
    for (const [token, poids] of poidsHistorique) {
      accumuler(token, poids, true);
    }

    if (scores.size === 0) return null;

    // Normalisation + bonus + plasticité ; sélection du meilleur (déterministe :
    // en cas d'égalité parfaite, la paire la plus ancienne gagne).
    let meilleurIndice = -1;
    let meilleurScore = 0;
    const requeteSet = new Set(tokensRequete);
    // it.86 — clé de motif de la requête (une fois par question) : détecte
    // le reposé TEXTUEL d'une paire apprise (bonus dominant, voir
    // BONUS_MOTIF_EXACT).
    const cleRequete = cleMotif(requete);
    // Tokens ACTIFS = requête + contexte (reprises) : la couverture d'une
    // paire s'évalue contre tout ce qui a nourri son score.
    const tokensActifs = new Set([...requeteSet, ...tokensContexte]);
    for (const token of poidsHistorique.keys()) tokensActifs.add(token);
    for (const [indice, brut] of scores) {
      const paire = this.paires[indice];
      // GARDE DE PROVENANCE — les paires « mesure » (matière hub de
      // l'auto-apprentissage) servent UNIQUEMENT à la mesure de rétention du
      // Studio : elles ne répondent JAMAIS dans la conversation.
      if (paire.provenance === "mesure" && !opts.inclureMesure) continue;
      const cumul = cumulLongueur.get(indice)!;
      const longueurEffective = Math.max(
        1,
        cumul.req + POIDS_CONTEXTE * cumul.ctx,
      );
      const normalise =
        brut / Math.sqrt(longueurEffective * paire.tailleTokens);
      const bonifie = normalise * (paire.personnalisee ? BONUS_PERSONNALISEE : 1);
      // Sous-ensemble exact : le motif entier est posé dans la requête.
      const sousEnsemble = [...paire.tokens].every((t) => requeteSet.has(t));
      // GARDE DE COUVERTURE — un verbe générique partagé (« écris ») ne suffit
      // plus à faire répondre une paire sur une demande riche : il faut ≥ 2
      // tokens partagés, OU une requête courte (suivi conversationnel), OU le
      // motif posé intégralement. Les NOMBRES PURS (« 38 ») ne comptent PAS
      // dans la couverture : un chiffre isolé d'un calcul n'est jamais un
      // sujet. Bug réel : une paire commerciale matchée sur « 38 ».
      const nonNumérique = (t: string): boolean => !/^\d+([.,]\d+)?$/.test(t);
      const partagés = [...paire.tokens].filter(
        (t) => tokensActifs.has(t) && nonNumérique(t),
      ).length;
      const requêteCourte = tokensRequete.length <= 3;
      const actifsNonNumériques = [...tokensActifs].filter(nonNumérique).length;
      // Requête « riche » = ≥ 4 tokens actifs hors nombres (calibrage 2e
      // itération : « Calcule 47 + 38… » porte 5 actifs dont 2 repris de la
      // paire « Calcule 20 % de 5,238 francs… » — le seuil 6 laissait ce
      // faux voisin répondre ; à 4, les gardes de couverture s'appliquent
      // et la couverture paire 0,33 < 0,45 le rejette).
      const requêteRiche = actifsNonNumériques >= 4;
      // it.85-r — COUVERTURE DE LA PAIRE (faux matchs tués par mesure) :
      // « Bravo, tu as vraiment perfectionné ton talent… » scoreait 8,53
      // contre la paire remerciement — UN seul token rare (« bravo ») sur
      // une question longue dictait la réponse. Désormais, une requête
      // riche exige que la paire soit substantiellement COUVERTE : ≥ 45 %
      // de ses tokens (hors nombres) doivent être présents, ET porter ≥ 25
      // % des tokens actifs de la requête. Une paire exacte reprise en
      // quasi-totalité passe (~1,0) ; un token isolé sur une paire de 8
      // tokens (0,12) est rejeté — la méthode de famille ou le pont
      // vocation prend alors la main. Requêtes courtes exemptées.
      const tokensPaireNonNumériques = [...paire.tokens].filter(nonNumérique);
      const couverturePaire =
        tokensPaireNonNumériques.length > 0
          ? partagés / tokensPaireNonNumériques.length
          : 0;
      // it.85-r (2e itération de calibrage) : une paire COURTE est facile à
      // « couvrir » côté paire (2 tokens sur 3 = 0,67) — le faux match
      // « Bravo… » (8,53) survivait à la seule couverture paire. Critère
      // conjoint pour les requêtes riches : la paire doit être couverte
      // (≥ 45 % d'elle-même) ET porter une part réelle de la requête
      // (≥ 25 % des tokens actifs) — un token isolé dictant la réponse
      // d'une question à 9 tokens (0,22) est rejeté des deux côtés.
      const couvertureRequete =
        actifsNonNumériques > 0 ? partagés / actifsNonNumériques : 0;
      const couvertureOK =
        // Sous-ensemble exact : le motif ENTIER est posé. Deux limites
        // mesurées : (1) une paire à 1-2 tokens (« bravo ») est un
        // sous-ensemble trivial de toute question longue — IDF rare ×
        // bonus sous-ensemble scoreait 8,53 → seules les paires
        // SUBSTANTIELLES (≥ 3 tokens hors nombres) sont sauvées sur une
        // requête riche ; (2) une paire 100 % NUMÉRIQUE (« 38 ») n'est
        // jamais un sujet — bug réel : une paire commerciale réveillée
        // par un chiffre isolé d'un calcul (les nombres sont exclus de
        // `partagés`, ils ne sauvent pas le sous-ensemble non plus).
        (sousEnsemble &&
          (tokensPaireNonNumériques.length >= 3 ||
            (requêteCourte && tokensPaireNonNumériques.length >= 1))) ||
        (partagés >= 2 &&
          (!requêteRiche ||
            (couverturePaire >= COUVERTURE_PAIRE_MIN &&
              couvertureRequete >= COUVERTURE_REQUETE_MIN))) ||
        (requêteCourte && partagés >= 1);
      if (!couvertureOK) continue;
      // GARDE DE LANGUE — une paire d'une autre langue que la requête ne
      // répond QUE si son motif est posé intégralement (sous-ensemble exact) :
      // jamais de réponse hors-sujet héritée d'un corpus d'une autre langue.
      if (!sousEnsemble) {
        const langueRequête = détecterLangue(requete);
        const langueRéponse = détecterLangue(paire.reponse);
        if (
          langueRequête !== null &&
          langueRéponse !== null &&
          langueRequête !== langueRéponse
        ) {
          continue;
        }
      }
      // it.86-b — GARDE DE COHÉRENCE NUMÉRIQUE : une paire de calcul dont
      // les opérandes ne figurent pas dans la requête est ignorée — la
      // méthode de famille ou la réponse instanciée prend alors la main.
      if (!equationCoherente(requete, paire.reponse)) continue;
      // La plasticité d'usage NE SECOURS PAS une correspondance médiocre :
      // le multiplicateur ne s'applique que si la paire passe déjà la barre
      // de base en score normalisé (sinon poids 1 — zéro inflation).
      const usageQualifié = normalise >= BARRE_BASE_USAGE ? paire.poidsUsage : 1;
      const final =
        bonifie *
        usageQualifié *
        (sousEnsemble ? BONUS_SOUS_ENSEMBLE : 1) *
        (paire.cle === cleRequete ? BONUS_MOTIF_EXACT : 1);
      if (final > meilleurScore) {
        meilleurScore = final;
        meilleurIndice = indice;
      }
    }

    if (meilleurIndice < 0 || meilleurScore < SEUIL_APPARIEMENT) return null;

    const gagnante = this.paires[meilleurIndice];

    // Plasticité d'usage : le rappel réussi renforce la paire (plafonné).
    if (gagnante.poidsUsage < POIDS_USAGE_MAX) {
      gagnante.poidsUsage = Math.min(
        POIDS_USAGE_MAX,
        gagnante.poidsUsage + GAIN_USAGE,
      );
      this.poidsParCle.set(
        cleMotif(gagnante.motif),
        gagnante.poidsUsage,
      );
    }

    const source: ReponseLangage["source"] = gagnante.personnalisee
      ? "personnalisee"
      : tokensContexte.length > 0 && tokensRequete.length <= 3
        ? "contexte"
        : "corpus";

    return {
      texte: gagnante.reponse,
      theme: gagnante.theme,
      score: Number(meilleurScore.toFixed(4)),
      source,
      cle: cleMotif(gagnante.motif),
    };
  }

  /**
   * PLASTICITÉ PAR FEEDBACK — renforce une paire (👍) : signal qualité
   * humain qui s'ajoute au comptage de rappels. Idempotent et plafonné.
   */
  renforcer(cle: string): boolean {
    const paire = this.trouverParCle(cle);
    if (!paire) return false;
    paire.poidsUsage = Math.min(POIDS_USAGE_MAX, paire.poidsUsage + GAIN_USAGE * 2);
    this.poidsParCle.set(cle, paire.poidsUsage);
    return true;
  }

  /**
   * PLASTICITÉ PAR FEEDBACK — affaiblit une paire (👎) : la réponse jugée
   * inutile régresse (facteur FACTEUR_AFFAIBLISSEMENT, plancher POIDS_USAGE_MIN)
   * sans jamais disparaître (le corpus d'amorçage reste la base honnête).
   */
  affaiblir(cle: string): boolean {
    const paire = this.trouverParCle(cle);
    if (!paire) return false;
    paire.poidsUsage = Math.max(
      POIDS_USAGE_MIN,
      paire.poidsUsage * FACTEUR_AFFAIBLISSEMENT,
    );
    this.poidsParCle.set(cle, paire.poidsUsage);
    return true;
  }

  /** Retrouve une paire indexée par sa clé de motif. */
  private trouverParCle(cle: string): PaireIndexee | null {
    if (!cle) return null;
    const indice = this.paires.findIndex((p) => cleMotif(p.motif) === cle);
    return indice >= 0 ? this.paires[indice] : null;
  }

  /** Nombre de paires personnalisées indexées. */
  compterPersonnalisees(): number {
    return this.paires.filter((p) => p.personnalisee).length;
  }

  /**
   * RÉÉDUCATION D'UNE PAIRE — remplace la réponse d'un motif déjà connu
   * (l'arène d'interférence corrige ainsi un élève qui répond à côté :
   * `apprendre` refuserait le motif en doublon). Le poids d'usage est
   * réinitialisé : la nouvelle réponse doit regagner sa plasticité.
   * Retourne true si une paire existante a été mise à jour.
   */
  reeducer(motif: string, nouvelleReponse: string, theme: string): boolean {
    const reponse = nouvelleReponse.trim();
    if (!motif.trim() || !reponse) return false;
    const cle = cleMotif(motif);
    if (!this.clesConnues.has(cle)) return false;
    const indice = this.paires.findIndex((p) => cleMotif(p.motif) === cle);
    if (indice < 0) return false;
    this.paires[indice] = {
      ...this.paires[indice],
      reponse,
      theme,
      poidsUsage: POIDS_USAGE_INITIAL,
    };
    this.poidsParCle.set(cle, POIDS_USAGE_INITIAL);
    return true;
  }

  /** Nombre total de paires indexées. */
  get nbPaires(): number {
    return this.paires.length;
  }

  /** Taille du vocabulaire indexé (tokens distincts des motifs). */
  get tailleVocabulaire(): number {
    return this.indexTokens.size;
  }

  /** Thèmes couverts (télémétrie / page Cerveau). */
  themes(): string[] {
    return [...new Set(this.paires.map((p) => p.theme))].sort();
  }

  /** Exporte l'état du cortex (persistance cerveau v2). */
  exporterEtat(): EtatLangage {
    const pairesPersonnalisees: PaireLangage[] = this.paires
      .filter((p) => p.personnalisee)
      .map((p) => ({ motif: p.motif, reponse: p.reponse, theme: p.theme }));

    const poidsUsage: Record<string, number> = {};
    for (const [cle, poids] of this.poidsParCle) {
      if (poids !== POIDS_USAGE_INITIAL) {
        poidsUsage[cle] = Number(poids.toFixed(4));
      }
    }

    return { pairesPersonnalisees, poidsUsage };
  }

  /** Restaure un état exporté (paires personnalisées + poids d'usage). */
  importerEtat(etat: Partial<EtatLangage>): StatsApprentissageLangage {
    if (etat.poidsUsage) {
      for (const [cle, poids] of Object.entries(etat.poidsUsage)) {
        if (typeof poids === "number" && poids > 0) {
          this.poidsParCle.set(cle, poids);
        }
      }
    }
    if (Array.isArray(etat.pairesPersonnalisees)) {
      const valides = etat.pairesPersonnalisees.filter(
        (p) =>
          p &&
          typeof p.motif === "string" &&
          typeof p.reponse === "string" &&
          p.motif.trim().length > 0 &&
          p.reponse.trim().length > 0,
      );
      return this.apprendre(valides, { personnalisees: true });
    }
    return {
      pairesAjoutees: 0,
      pairesDoublons: 0,
      vocabulaire: this.indexTokens.size,
      totalPaires: this.paires.length,
    };
  }

  /** Oublie toutes les paires personnalisées (reset pédagogique). */
  oublierPersonnalisees(): number {
    const indicesASupprimer = new Set<number>();
    this.paires.forEach((p, i) => {
      if (p.personnalisee) indicesASupprimer.add(i);
    });
    if (indicesASupprimer.size === 0) return 0;

    // Reconstruction compacte (index inclus) — opération rare, coût OK.
    const restantes = this.paires.filter((_, i) => !indicesASupprimer.has(i));
    this.paires.length = 0;
    this.indexTokens.clear();
    this.clesConnues.clear();

    for (const paire of restantes) {
      const cle = cleMotif(paire.motif);
      const indice = this.paires.length;
      this.paires.push({ ...paire, personnalisee: false });
      this.clesConnues.add(cle);
      for (const token of paire.tokens) {
        let liste = this.indexTokens.get(token);
        if (!liste) {
          liste = [];
          this.indexTokens.set(token, liste);
        }
        liste.push(indice);
      }
    }
    return indicesASupprimer.size;
  }
}
