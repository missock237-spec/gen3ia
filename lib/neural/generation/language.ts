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

/** Seuil d'appariement (score cosinus pondéré IDF) au-delà duquel une paire répond. */
export const SEUIL_APPARIEMENT = 0.34;

/** Bonus multiplicatif des paires personnalisées (connaissances enseignées). */
export const BONUS_PERSONNALISEE = 1.25;

/**
 * Bonus de sous-ensemble : quand la totalité des tokens informatifs du motif
 * est contenue dans la requête, l'utilisateur a posé exactement cette question
 * (peut-être avec des mots en plus) — signal fort, bonus déterministe.
 */
export const BONUS_SOUS_ENSEMBLE = 1.6;

/** Poids des tokens du tour précédent (contexte anaphorique). */
export const POIDS_CONTEXTE = 0.35;

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

/** Paire interne indexée. */
interface PaireIndexee {
  motif: string;
  reponse: string;
  theme: string;
  /** Tokens normalisés du motif (dédupliqués). */
  tokens: Set<string>;
  /** Liste ordonnée (pour la normalisation). */
  tailleTokens: number;
  /** Paire enseignée par l'utilisateur (Studio d'entraînement). */
  personnalisee: boolean;
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
}

/** Contexte conversationnel fourni par le moteur (hippocampe). */
export interface ContexteLangage {
  /** Message utilisateur précédent (pour les reprises courtes). */
  messagePrecedent?: string;
  /** Réponse de l'IA précédente (pour éviter les répétitions totales). */
  reponsePrecedente?: string;
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
    opts: { personnalisees?: boolean } = {},
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

      // Budget de paires personnalisées (le corpus d'amorçage n'y compte pas).
      if (personnalisees && this.compterPersonnalisees() >= MAX_PAIRES_PERSONNALISEES) {
        break;
      }

      const tokens = new Set(tokensInformatifs(tokenize(paire.motif)));
      if (tokens.size === 0) {
        // Motif 100 % stopwords : non indexable, jamais rappelable — ignoré.
        doublons += 1;
        continue;
      }
      const index: PaireIndexee = {
        motif: paire.motif.trim(),
        reponse: paire.reponse.trim(),
        theme: paire.theme,
        tokens,
        tailleTokens: Math.max(1, tokens.size),
        personnalisee: personnalisees,
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
  ): ReponseLangage | null {
    if (this.paires.length === 0) return null;

    const tokensRequete = tokensInformatifs([...new Set(tokenize(requete))]);
    if (tokensRequete.length === 0) return null;

    // Tokens de contexte (reprises) : uniquement ceux absents de la requête.
    const tokensContexte = contexte.messagePrecedent
      ? tokensInformatifs([...new Set(tokenize(contexte.messagePrecedent))]).filter(
          (t) => !tokensRequete.includes(t),
        )
      : [];

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

    if (scores.size === 0) return null;

    // Normalisation + bonus + plasticité ; sélection du meilleur (déterministe :
    // en cas d'égalité parfaite, la paire la plus ancienne gagne).
    let meilleurIndice = -1;
    let meilleurScore = 0;
    const requeteSet = new Set(tokensRequete);
    for (const [indice, brut] of scores) {
      const paire = this.paires[indice];
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
      const final =
        bonifie * paire.poidsUsage * (sousEnsemble ? BONUS_SOUS_ENSEMBLE : 1);
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
    };
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
