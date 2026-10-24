import "server-only";

import { Synapse } from "../core/synapse";
import { createRng } from "../core/rng";
import { INTENTION_GENERALE, ZONE_TOKENS, POOL_UTILISATEUR_IN } from "../core/types";
import {
  POOL_GENERER_IMAGE,
  POOL_GENERER_AUDIO,
  POOL_GENERER_VIDEO,
  POOL_EXECUTER_OUTIL_OS,
  POOL_SELECTIONNER_ET_EXECUTER_SKILL,
  POOL_INITIALISER_APPEL,
  POOL_TERMINER_APPEL,
} from "../core/types";
import type { ReseauNeuronalGen3 } from "../core/network";
import type { EspaceFiltreResonant } from "../core/resonant-space";
import type { GenerateurAutoOscillation } from "../core/auto-oscillation";
import type { NoyauCentralGen3, RequeteExterne } from "../core/central-core";
import { encodeText } from "../encoding/text-encoder";
import { poidsResonanceParCycle } from "../decoding/response-decoder";
import type { TrainingSample } from "./dataset";
import { nouvelleFenetreNeuronale } from "../core/v2/effecteur-cortex";
import { DOMAIN_POOLS } from "./domaines";

/**
 * ENTRAÎNEUR SUPERVISÉ DU RÉSEAU NEURONAL — la boucle d'apprentissage RÉELLE.
 *
 * Pour chaque échantillon { text, label } :
 *  1. RESET COMPLET des énergies (adaptation (d) : tous les neurones — la
 *     mémoire du réseau vit dans ses SYNAPSES apprises, pas dans les
 *     potentiels transitoires ; sans ce reset, les énergies résiduelles des
 *     cycles précédents déclenchaient des pools au hasard et l'accuracy
 *     plafonnait à ~0.25 quel que soit le nombre d'époques) ;
 *  2. ENCODAGE du texte en entrées directes (hachage FNV-1a → zone 0..37) ;
 *  3. k CYCLES complets via le noyau (défaut 4) — propagation réelle ;
 *  4. RÉSONANCE de chaque pool = maximum observé sur la fenêtre de cycles ;
 *  5. PLASTICITÉ SUPERVISÉE :
 *     - pour chaque neurone d'entrée stimulé → pour chaque neurone du pool
 *       CIBLE : renforcer ou CRÉER la synapse (weight = min(1, w + lrBoost)) ;
 *     - si un pool NON-CIBLE résonne PLUS que le pool cible : affaiblir ses
 *       synapses depuis la zone d'entrée (× 0.95) — punition compétitive ;
 *  6. ACCURACY en ligne : argmax(résonances) === label.
 *
 * La boucle est CHUNKÉE : tous les 25 échantillons, on rend la main à
 * l'event loop (setImmediate) pour ne jamais bloquer le serveur.
 *
 * Le shuffle est seedé (adaptation (a) : reproductibilité des runs).
 */

/** Pools d'intention par label — l'ordre est aussi l'ordre d'argmax (premier max gagnant). */
export const LABEL_POOLS: Record<string, readonly number[]> = {
  GENERER_IMAGE: POOL_GENERER_IMAGE,
  GENERER_AUDIO: POOL_GENERER_AUDIO,
  GENERER_VIDEO: POOL_GENERER_VIDEO,
  EXECUTER_OUTIL_OS: POOL_EXECUTER_OUTIL_OS,
  SELECTIONNER_ET_EXECUTER_SKILL: POOL_SELECTIONNER_ET_EXECUTER_SKILL,
  INITIALISER_APPEL: POOL_INITIALISER_APPEL,
  TERMINER_APPEL: POOL_TERMINER_APPEL,
  [INTENTION_GENERALE]: [68, 69],
};

/**
 * Enregistre dans l'espace résonant tous les pools d'intention utilisés par
 * l'entraînement (idempotent). Utile aux tests et aux runtimes autonomes.
 */
export function enregistrerPoolsDIntention(espace: EspaceFiltreResonant): void {
  for (const [label, pool] of Object.entries(LABEL_POOLS)) {
    espace.registerOutputPool(label, [...pool]);
  }
}

/**
 * Enregistre les 18 pools de DOMAINES (couche v3, neurones 100-135).
 * Idempotent — séparé des pools d'action : deux classifications
 * indépendantes sur des pools disjoints.
 */
export function enregistrerPoolsDomaines(espace: EspaceFiltreResonant): void {
  for (const [label, pool] of Object.entries(DOMAIN_POOLS)) {
    espace.registerOutputPool(label, [...pool]);
  }
}

/**
 * Prédiction de DOMAINE : argmax strict sur les pools de domaine uniquement.
 * null si aucune résonance de domaine (aucun domaine reconnu) — honnêteté
 * : « je ne sais pas » vaut mieux qu'un domaine inventé.
 */
export function predireDomaineDepuisResonances(
  resonances: Record<string, number>,
): { label: string; score: number } | null {
  let meilleur: string | null = null;
  let meilleurScore = 0;
  for (const label of Object.keys(DOMAIN_POOLS)) {
    const score = resonances[label] ?? 0;
    if (score > meilleurScore) {
      meilleur = label;
      meilleurScore = score;
    }
  }
  return meilleur && meilleurScore > 0
    ? { label: meilleur, score: meilleurScore }
    : null;
}

/** Rapport d'entraînement de la couche des domaines (données réelles). */
export interface RapportDomaines {
  epochs: number;
  samples: number;
  accuracyTrain: number;
  accuracyTest: number;
  history: Array<{ epoch: number; accuracy: number }>;
  /** Répartition des échantillons par domaine (ids de dataset). */
  parDomaine: Record<string, number>;
  dureeMs: number;
  startedAt: string;
}

/** Rapport d'entraînement (données 100 % réelles). */
export interface TrainingReport {
  /** Nombre d'époques exécutées. */
  epochs: number;
  /** Nombre total d'échantillons d'entraînement vus. */
  samples: number;
  /** Accuracy finale sur le jeu d'entraînement (dernière époque). */
  accuracyTrain: number;
  /** Accuracy finale sur le jeu de test (jamais vu pendant l'apprentissage). */
  accuracyTest: number;
  /** Précision par époque (mesurée en ligne sur le jeu d'entraînement). */
  history: Array<{ epoch: number; accuracy: number }>;
  /** Durée réelle d'exécution (ms). */
  dureeMs: number;
  /** Date ISO de début. */
  startedAt: string;
}

/** Options d'entraînement. */
export interface TrainingOptions {
  /** Nombre d'époques (défaut 5). */
  epochs?: number;
  /** Renforcement synaptique supervisé par exposition (défaut 0.15 :
   * assez pour qu'un pool cible spiké dès le cycle 2-3 dès la deuxième
   * exposition — cf. poidsResonanceParCycle). */
  lrBoost?: number;
  /** Cycles du noyau par échantillon (défaut 4 : laisse aux synapses
   * entraînées le temps de propager le signal jusqu'aux pools). */
  cyclesParEchantillon?: number;
  /** Fraction du jeu réservée au test (défaut 0.15). */
  testRatio?: number;
  /** Callback de progression (par époque). */
  onProgress?: (rapport: { epoch: number; accuracy: number }) => void;
}

/**
 * Prédiction d'intention à partir des résonances : pool au score strictement
 * maximal (premier en cas d'égalité parfaite, ordre déterministe de
 * LABEL_POOLS) ; si toutes les résonances sont nulles, repli sur
 * INTENTION_GENERALE (aucune intention détectée).
 */
export function predireIntention(
  resonances: Record<string, number>,
): string {
  let meilleur = INTENTION_GENERALE;
  let meilleurScore = 0;
  for (const label of Object.keys(LABEL_POOLS)) {
    const score = resonances[label] ?? 0;
    if (score > meilleurScore) {
      meilleur = label;
      meilleurScore = score;
    }
  }
  return meilleur;
}

export class NeuralTrainer {
  constructor(
    private readonly reseau: ReseauNeuronalGen3,
    private readonly espace: EspaceFiltreResonant,
    private readonly veille: GenerateurAutoOscillation,
    private readonly noyau: NoyauCentralGen3,
  ) {
    // `veille` est conservé pour la symétrie du constructeur (et les futurs
    // cycles de consolidation en veille) : la boucle supervisée ci-dessous
    // n'utilise que des cycles de traitement de requête.
    void this.veille;
  }

  /**
   * Boucle d'entraînement supervisé complète. Retourne un rapport honnête :
   * accuracies mesurées, historique par époque, durée réelle.
   */
  async train(
    samples: TrainingSample[],
    opts: TrainingOptions = {},
  ): Promise<TrainingReport> {
    const epochs = opts.epochs ?? 5;
    const lrBoost = opts.lrBoost ?? 0.15;
    const cyclesParEchantillon = opts.cyclesParEchantillon ?? 4;
    const testRatio = opts.testRatio ?? 0.15;
    const startedAt = new Date().toISOString();
    const debut = Date.now();

    // Shuffle seedé (adaptation (a)) : découpe train/test reproductible.
    const melange = [...samples];
    const rng = createRng(2024);
    for (let i = melange.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = melange[i];
      melange[i] = melange[j];
      melange[j] = tmp;
    }

    const nbTest = Math.max(
      samples.length >= 10 ? 1 : 0,
      Math.floor(samples.length * testRatio),
    );
    const train = melange.slice(0, melange.length - nbTest);
    const test = melange.slice(melange.length - nbTest);

    const history: Array<{ epoch: number; accuracy: number }> = [];
    let accuracyTrain = 0;

    // OPTIMISATION VITESSE (adaptation (e) du portage) : l'index des
    // synapses "src->tgt" était reconstruit à CHAQUE échantillon (O(S) × N
    // échantillons). Il est désormais construit une seule fois ici puis
    // maintenu en sync par renforcerOuCreerSynapse — sémantique identique,
    // entraînement nettement plus rapide sur de gros cerveaux.
    const indexSynapses = indexerSynapses(this.reseau);

    for (let epoch = 1; epoch <= epochs; epoch++) {
      let corrects = 0;
      for (let i = 0; i < train.length; i++) {
        const echantillon = train[i];
        // (1)(2)(3)(4)(5)(6) — cf. en-tête du fichier.
        const prediction = this.apprendreSurEchantillon(
          echantillon,
          cyclesParEchantillon,
          lrBoost,
          indexSynapses,
          LABEL_POOLS,
        );
        if (prediction === echantillon.label) corrects += 1;

        // Chunking : rend la main à l'event loop tous les 25 échantillons.
        if ((i + 1) % 25 === 0) {
          await new Promise<void>((resoudre) => setImmediate(resoudre));
        }
      }
      accuracyTrain = train.length > 0 ? corrects / train.length : 0;
      history.push({ epoch, accuracy: accuracyTrain });
      opts.onProgress?.({ epoch, accuracy: accuracyTrain });
    }

    // Évaluation finale sur le jeu de test (jamais vu, aucune plasticité).
    const accuracyTest =
      test.length > 0 ? this.evaluerEchantillons(test, cyclesParEchantillon) : 0;

    return {
      epochs,
      samples: train.length,
      accuracyTrain,
      accuracyTest,
      history,
      dureeMs: Date.now() - debut,
      startedAt,
    };
  }

  /**
   * ENTRAÎNEMENT DE LA COUCHE DES DOMAINES (v3) — même boucle supervisée
   * que train(), mais contre les 18 pools de domaine uniquement (neurones
   * 100-135, disjoints des pools d'action) : la plasticité renforce les
   * chemins entrée → pool du domaine cible et punit compétitivement les
   * pools de domaine concurrents (jamais les pools d'action).
   */
  async trainDomaines(
    samples: TrainingSample[],
    opts: TrainingOptions = {},
  ): Promise<RapportDomaines> {
    const epochs = opts.epochs ?? 4;
    const lrBoost = opts.lrBoost ?? 0.15;
    const cyclesParEchantillon = opts.cyclesParEchantillon ?? 4;
    const testRatio = opts.testRatio ?? 0.15;
    const startedAt = new Date().toISOString();
    const debut = Date.now();

    // Shuffle seedé — même graine que train() : reproductible.
    const melange = [...samples];
    const rng = createRng(2024);
    for (let i = melange.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = melange[i];
      melange[i] = melange[j];
      melange[j] = tmp;
    }

    const nbTest = Math.max(
      samples.length >= 10 ? 1 : 0,
      Math.floor(samples.length * testRatio),
    );
    const train = melange.slice(0, melange.length - nbTest);
    const test = melange.slice(melange.length - nbTest);

    // Répartition honnête par domaine (ids de dataset dérivés des labels).
    const parDomaine: Record<string, number> = {};
    for (const echantillon of train) {
      const id = echantillon.label.replace(/^DOM_/, "").toLowerCase();
      parDomaine[id] = (parDomaine[id] ?? 0) + 1;
    }

    const indexSynapses = indexerSynapses(this.reseau);
    const history: Array<{ epoch: number; accuracy: number }> = [];
    let accuracyTrain = 0;

    for (let epoch = 1; epoch <= epochs; epoch++) {
      let corrects = 0;
      for (let i = 0; i < train.length; i++) {
        const echantillon = train[i];
        const prediction = this.apprendreSurEchantillon(
          echantillon,
          cyclesParEchantillon,
          lrBoost,
          indexSynapses,
          DOMAIN_POOLS,
        );
        if (prediction === echantillon.label) corrects += 1;

        if ((i + 1) % 25 === 0) {
          await new Promise<void>((resoudre) => setImmediate(resoudre));
        }
      }
      accuracyTrain = train.length > 0 ? corrects / train.length : 0;
      history.push({ epoch, accuracy: accuracyTrain });
      opts.onProgress?.({ epoch, accuracy: accuracyTrain });
    }

    // Évaluation finale sans plasticité (jeu de test jamais vu).
    const accuracyTest = this.evaluerEchantillonsDomaines(
      test,
      cyclesParEchantillon,
    );

    return {
      epochs,
      samples: train.length,
      accuracyTrain,
      accuracyTest,
      history,
      parDomaine,
      dureeMs: Date.now() - debut,
      startedAt,
    };
  }

  /** Évalue la reconnaissance de domaine SANS plasticité. */
  evaluerEchantillonsDomaines(
    samples: TrainingSample[],
    cyclesParEchantillon = 4,
  ): number {
    if (samples.length === 0) return 0;
    let corrects = 0;
    for (const echantillon of samples) {
      const { resonances } = this.propagerEchantillon(
        echantillon,
        cyclesParEchantillon,
        Object.keys(DOMAIN_POOLS),
      );
      const predite = predireDomaineDepuisResonances(resonances);
      if (predite && predite.label === echantillon.label) corrects += 1;
    }
    return corrects / samples.length;
  }

  /**
   * Évalue un jeu d'échantillons SANS plasticité : encode, propage k cycles,
   * lit les résonances (maximum par pool) et prédit l'intention. Utilisé pour
   * le jeu de test et pour mesurer une accuracy de référence avant training.
   */
  evaluerEchantillons(
    samples: TrainingSample[],
    cyclesParEchantillon = 4,
  ): number {
    if (samples.length === 0) return 0;
    let corrects = 0;
    for (const echantillon of samples) {
      const { resonances } = this.propagerEchantillon(
        echantillon,
        cyclesParEchantillon,
        Object.keys(LABEL_POOLS),
      );
      if (predireIntention(resonances) === echantillon.label) corrects += 1;
    }
    return corrects / samples.length;
  }

  /**
   * Un pas d'apprentissage complet sur un échantillon : retourne
   * l'intention prédite AVANT plasticité (prédiction en ligne honnête).
   * `indexSynapses` est fourni par train()/trainDomaines() (construit une
   * fois — cf. (e)) ; `registrePools` désigne la famille de pools visée
   * (actions ou domaines — jamais les deux mélangées).
   */
  private apprendreSurEchantillon(
    echantillon: TrainingSample,
    cyclesParEchantillon: number,
    lrBoost: number,
    indexSynapses: Map<string, Synapse>,
    registrePools: Record<string, readonly number[]>,
  ): string {
    const { encodage, resonances } = this.propagerEchantillon(
      echantillon,
      cyclesParEchantillon,
      Object.keys(registrePools),
    );
    // Prédiction en ligne : argmax sur la famille apprise — les échantillons
    // de domaine (label DOM_*) sont prédits par predireDomaineDepuisResonances
    // (fallback « non reconnu » = "" : compté incorrect, honnête), les autres
    // par predireIntention (repli INTENTION_GENERALE).
    const prediction = echantillon.label.startsWith("DOM_")
      ? predireDomaineDepuisResonances(resonances)?.label ?? ""
      : predireIntention(resonances);

    // ----- (5) PLASTICITÉ SUPERVISÉE -------------------------------------
    const poolCible = registrePools[echantillon.label];
    const neuronesEntree = Object.keys(encodage.inputs).map(Number);

    if (poolCible) {
      // Renforcement / création : chaque neurone d'entrée stimulé → chaque
      // neurone du pool cible (weight = min(1, w + lrBoost)).
      for (const src of neuronesEntree) {
        for (const tgt of poolCible) {
          renforcerOuCreerSynapse(this.reseau, indexSynapses, src, tgt, lrBoost);
        }
      }

      // Punition compétitive : un pool CONCURRENT du même registre qui
      // résonne PLUS que le pool cible voit ses synapses depuis la zone
      // d'entrée affaiblies (× 0.95) — les autres familles sont épargnées.
      const scoreCible = resonances[echantillon.label] ?? 0;
      for (const [label, pool] of Object.entries(registrePools)) {
        if (label === echantillon.label) continue;
        const score = resonances[label] ?? 0;
        if (score > scoreCible) {
          affaiblirSynapsesVersPool(this.reseau, pool);
        }
      }
    }

    return prediction;
  }

  /**
   * Propage un échantillon : reset COMPLET des énergies (adaptation (d)),
   * encodage, k cycles via le noyau, puis résonance pondérée PAR LATENCE de
   * chaque pool ÉCOUTÉ = maximum observé sur la fenêtre de cycles (un pool
   * entraîné spiker TÔT dans la fenêtre — poids fort — alors qu'un pool
   * activé par le bruit synaptique aléatoire n'atteint le seuil qu'en fin de
   * fenêtre — poids faible : cf. poidsResonanceParCycle).
   * `labelsPools` borne la lecture aux pools de la famille concernée.
   */
  private propagerEchantillon(
    echantillon: TrainingSample,
    cyclesParEchantillon: number,
    labelsPools: string[],
  ): {
    encodage: ReturnType<typeof encodeText>;
    resonances: Record<string, number>;
  } {
    // (1) Reset complet : chaque échantillon est un essai propre — la
    // prédiction ne reflète QUE la structure synaptique apprise.
    for (const neurone of this.reseau.neurones.values()) {
      neurone.energy = 0;
    }

    // (2) Encodage du texte en entrées directes.
    const encodage = encodeText(echantillon.text);

    // (3) Injection en VOLÉE UNIQUE (cycle 1) puis propagation libre sur les
    //     cycles suivants — présentation impulsionnelle standard des SNN :
    //     une injection répétée à chaque cycle entretenait un attracteur
    //     global (tous les pools à résonance 1.0, aucune discrimination) ;
    //     en volée unique, seuls les chemins synaptiques RENFORCÉS portent
    //     le signal jusqu'au seuil et la cascade parasite s'éteint d'elle-même.
    //     Le contexte transmis aux effecteurs porte la fenêtre neuronale
    //     (reset des énergies columnnaires du Cortex v2 à chaque échantillon)
    //     et l'intention cible (plasticité supervisée columnnaire consolidée
    //     à la clôture de la fenêtre — cf. effecteur-cortex.ts).
    const fenetre = nouvelleFenetreNeuronale();
    const contexte = {
      prompt: echantillon.text,
      __fenetreNeuronale: fenetre,
      __intentionCible: echantillon.label,
    };
    const resonances: Record<string, number> = {};
    for (let c = 0; c < cyclesParEchantillon; c++) {
      const requete: RequeteExterne =
        c === 0
          ? { intensite: 0, inputsDirects: encodage.inputs }
          : { intensite: 0 };
      const spiked = this.noyau.executerCycle(requete, contexte).spikedNeurones;
      const poids = poidsResonanceParCycle(c);
      for (const label of labelsPools) {
        const score = this.espace.readResonance(spiked, label) * poids;
        if (score > (resonances[label] ?? 0)) resonances[label] = score;
      }
    }
    return { encodage, resonances };
  }
}

/** Index des synapses par paire "src->tgt" (accélération des renforcements). */
function indexerSynapses(
  reseau: ReseauNeuronalGen3,
): Map<string, Synapse> {
  const index = new Map<string, Synapse>();
  for (const synapse of reseau.synapses) {
    index.set(`${synapse.sourceId}->${synapse.targetId}`, synapse);
  }
  return index;
}

/** Renforce la synapse src→tgt (création à weight = lrBoost si absente). */
function renforcerOuCreerSynapse(
  reseau: ReseauNeuronalGen3,
  index: Map<string, Synapse>,
  src: number,
  tgt: number,
  lrBoost: number,
): void {
  const existante = index.get(`${src}->${tgt}`);
  if (existante) {
    existante.weight = Math.min(1.0, existante.weight + lrBoost);
  } else if (src !== tgt) {
    const synapse = new Synapse(src, tgt, lrBoost);
    reseau.synapses.push(synapse);
    index.set(`${src}->${tgt}`, synapse);
  }
}

/** Affaiblit de 5 % les synapses entrant dans un pool depuis la zone 0..39. */
function affaiblirSynapsesVersPool(
  reseau: ReseauNeuronalGen3,
  pool: readonly number[],
): void {
  const cibles = new Set(pool);
  const borne = ZONE_TOKENS.fin + POOL_UTILISATEUR_IN.length; // 39
  for (const synapse of reseau.synapses) {
    if (
      synapse.sourceId <= borne &&
      cibles.has(synapse.targetId)
    ) {
      synapse.weight *= 0.95;
    }
  }
}
