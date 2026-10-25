import type { StatsApprentissageLangage } from "./generation/language";
import { détecterLangue } from "./generation/language";
/**
 * MOTEUR D'ÉVOLUTION CONTINUE GEN3 — le système qui fait que l'IA
 * progresse à chaque conversation, sans jamais inventer.
 *
 * PRINCIPE (cohérence avec le cortex langagier et le SNN) :
 *  1. OBSERVATION — chaque échange réussi (réponse venue du cortex, avec un
 *     score d'appariement correct) est observé par le moteur d'évolution ;
 *  2. CONSOLIDATION — périodiquement (tous les SEUIL_CONSOLIDATION échanges
 *     observés), le moteur rejoue la file : les échanges de qualité deviennent
 *     des paires personnalisées de la mémoire longue (méthode apprendre du
 *     cortex — les doublons sont dédupliqués par le cortex lui-même) ;
 *  3. PERSISTANCE — après chaque cycle de consolidation, un callback
 *     (câblé par le runtime sur la sauvegarde du cerveau) rend l'évolution
 *     durable ;
 *  4. MESURE — les métriques d'évolution (échanges observés, consolidés,
 *     cycles effectués) sont exposées à la page Cerveau et aux stats
 *     publiques : l'évolution est VISIBLE, jamais prétendue.
 *
 * RÈGLES D'HONNÊTETÉ :
 *  - seules les réponses VENUES DU CORTEX (corpus, personnalisée, contexte)
 *    sont consolidées — les compositions du décodeur (télémétries réseau,
 *    données de runtime) ne sont PAS des connaissances stables ;
 *  - un score d'appariement trop bas n'est jamais consolidé (ce n'était
 *    pas un rappel fiable) ;
 *  - la file est bornée (garde-fou mémoire) et la consolidation est
 *    plafonnée par cycle (jamais de rafale d'apprentissage).
 *
 * Module PUR — aucune dépendance Node, aucune I/O (le callback de
 * persistance est injecté).
 */

/** Échange observé (question utilisateur → réponse de l'IA, avec provenance). */
export interface EchangeObserve {
  /** Message de l'utilisateur (motif de rappel). */
  question: string;
  /** Réponse émise par l'IA (à graver si elle était fiable). */
  reponse: string;
  /** Score d'appariement cortex (0 pour une composition du décodeur). */
  score: number;
  /** Source du langage (cortex_corpus, cortex_personnalisee, cortex_contexte, decoder_intention). */
  source: string;
}

/** Métriques d'évolution — données 100 % réelles, exposées telles quelles. */
export interface MetriquesEvolution {
  /** Échanges observés depuis le démarrage du runtime. */
  echangesObserves: number;
  /** Échanges convertis en connaissances durables (paires enseignées, doublons compris). */
  echangesConsolides: number;
  /** Cycles de consolidation effectués. */
  cyclesConsolidation: number;
  /** Échanges écartés (source décodeur ou score insuffisant — comptés honnêtement). */
  echangesEcarts: number;
  /** Date ISO du dernier cycle de consolidation (null si jamais). */
  derniereConsolidation: string | null;
}

/** Options du moteur (seuils calibrés, modifiables pour les tests). */
export interface OptionsEvolution {
  /** Score minimal d'appariement pour qu'un échange soit consolidé. */
  seuilScore?: number;
  /** Nombre d'échanges observés déclenchant un cycle de consolidation. */
  periodicite?: number;
  /** Taille maximale de la file d'attente (garde-fou mémoire). */
  tailleFileMax?: number;
  /** Paires maximales consolidées par cycle (jamais de rafale). */
  maxParCycle?: number;
}

/** Sources consolidables : uniquement les rappels du cortex langagier. */
const SOURCES_CONSOLIDABLES = new Set(["cortex_corpus", "cortex_personnalisee", "cortex_contexte"]);

/** Valeurs par défaut des options. */
const SEUIL_SCORE_DEFAUT = 0.5;
const PERIODICITE_DEFAUT = 8;
const TAILLE_FILE_MAX_DEFAUT = 64;
const MAX_PAR_CYCLE_DEFAUT = 12;

/** Résultat d'un cycle de consolidation. */
export interface ResultatConsolidation {
  /** Paires réellement enseignées au cortex (nouvelles connaissances). */
  enseignees: number;
  /** Échanges rejetés (score insuffisant ou source non consolidable). */
  ecarts: number;
  /** Paires ignorées car déjà connues du cortex (dédupliquées par motif). */
  dejaConnues: number;
  /** Stats d'apprentissage brutes renvoyées par le cortex. */
  stats: StatsApprentissageLangage | null;
}

/** Contrat minimal du cortex utilisé par le moteur (testabilité). */
export interface CortexConsolidable {
  apprendre(paires: ReadonlyArray<{ motif: string; reponse: string; theme: string }>, opts: { personnalisees: boolean }): StatsApprentissageLangage;
  compterPersonnalisees(): number;
}

export class MoteurEvolutionGen3 {
  private readonly file: EchangeObserve[] = [];
  private readonly seuilScore: number;
  private readonly periodicite: number;
  private readonly tailleFileMax: number;
  private readonly maxParCycle: number;

  private echangesObserves = 0;
  private echangesConsolides = 0;
  private cycles = 0;
  private echangesEcarts = 0;
  private derniereConsolidation: string | null = null;

  constructor(
    private readonly cortex: CortexConsolidable | null,
    options: OptionsEvolution = {},
  ) {
    this.seuilScore = options.seuilScore ?? SEUIL_SCORE_DEFAUT;
    this.periodicite = Math.max(1, options.periodicite ?? PERIODICITE_DEFAUT);
    this.tailleFileMax = Math.max(1, options.tailleFileMax ?? TAILLE_FILE_MAX_DEFAUT);
    this.maxParCycle = Math.max(1, options.maxParCycle ?? MAX_PAR_CYCLE_DEFAUT);
  }

  /**
   * Observe un échange. Retourne le nombre d'échanges accumulés.
   * Les échanges non consolidables (source décodeur, score trop bas, champs
   * vides) sont comptés « écartés » immédiatement — la file ne garde que
   * des candidats plausibles.
   */
  observer(echange: EchangeObserve): number {
    this.echangesObserves += 1;
    const question = echange.question?.trim() ?? "";
    const reponse = echange.reponse?.trim() ?? "";
    // FILTRE D'ÉCRITURE — une réponse en écriture NON LATINE (arabe,
    // cyrillique…) ne devient jamais mémoire longue : le cortex
    // conversationnel de la plateforme latine ne consolide que ce qu'il
    // peut re-servir (bug réel : paire arabe consolidée, servie à tous).
    // Les réponses courtes neutres (« 312 neurones actifs ») restent admises.
    const langue = détecterLangue(reponse);
    const consolidable =
      question.length > 0 &&
      reponse.length > 0 &&
      langue !== "autre" &&
      SOURCES_CONSOLIDABLES.has(echange.source) &&
      echange.score >= this.seuilScore;
    if (!consolidable) {
      this.echangesEcarts += 1;
      return this.file.length;
    }
    this.file.push({ question: question.slice(0, 2000), reponse: reponse.slice(0, 8000), score: echange.score, source: echange.source });
    if (this.file.length > this.tailleFileMax) {
      this.file.splice(0, this.file.length - this.tailleFileMax);
    }
    return this.file.length;
  }

  /** Un cycle de consolidation est-il déclenché au prochain appel ? */
  pretPourConsolidation(): boolean {
    return this.file.length >= this.periodicite;
  }

  /**
   * Consolide la file : les échanges de qualité deviennent des paires
   * personnalisées du cortex (mémoire longue). Idempotent : le cortex
   * déduplique les motifs déjà connus. Retourne le détail honnête.
   */
  consolider(): ResultatConsolidation {
    if (this.file.length === 0 || !this.cortex) {
      return { enseignees: 0, ecarts: 0, dejaConnues: 0, stats: null };
    }
    const candidats = this.file
      .splice(0, Math.min(this.maxParCycle, this.file.length))
      .map((e) => ({ motif: e.question, reponse: e.reponse, theme: "consolide" }));
    const avant = this.cortex.compterPersonnalisees();
    const stats = this.cortex.apprendre(candidats, { personnalisees: true });
    const apres = this.cortex.compterPersonnalisees();

    this.cycles += 1;
    this.echangesConsolides += stats.pairesAjoutees;
    this.echangesEcarts += stats.pairesDoublons;
    this.derniereConsolidation = new Date().toISOString();

    return {
      enseignees: Math.max(0, apres - avant),
      ecarts: candidats.length - stats.pairesAjoutees - stats.pairesDoublons,
      dejaConnues: stats.pairesDoublons,
      stats,
    };
  }

  /** Exécute une consolidation si la périodicité est atteinte. */
  consoliderSiPret(): ResultatConsolidation | null {
    if (!this.pretPourConsolidation()) return null;
    return this.consolider();
  }

  /** Métriques d'évolution réelles (page Cerveau, stats publiques). */
  metriques(): MetriquesEvolution {
    return {
      echangesObserves: this.echangesObserves,
      echangesConsolides: this.echangesConsolides,
      cyclesConsolidation: this.cycles,
      echangesEcarts: this.echangesEcarts,
      derniereConsolidation: this.derniereConsolidation,
    };
  }
}
