/**
 * RÉSEAU NEURONAL GEN3 — portage fidèle de la classe `ReseauNeuronalGen3`
 * de la source Python (Système neuronal.pdf).
 *
 * Le cerveau est un graphe dirigé de neurones « accumulate-and-fire » reliés
 * par des synapses pondérées. Un pas de temps (step) suit l'ORDRE EXACT de la
 * source : (1) injection des entrées externes, (2) updateState de tous les
 * neurones → liste des spikes, (3) transmission de l'énergie le long des
 * synapses dont la source a spike, avec plasticité (renforcement si la cible
 * s'est activée récemment).
 *
 * Module PUR — aucune dépendance Node.
 */

import { Neurone } from "./neuron";
import { Synapse } from "./synapse";
import { createRng, randUniform } from "./rng";
import { METABOLISME_CUMUL_ZERO, NEURAL_CONFIG_DEFAUTS } from "./types";
import type {
  MetabolismeCumul,
  MetabolismePas,
  NeuralConfig,
} from "./types";

/** État sérialisable du réseau (persistance, cf. training/persistence.ts). */
export interface ReseauStateExport {
  /** Configuration exacte ayant produit le réseau. */
  config: NeuralConfig;
  /** Synapses sérialisées compactes : [sourceId, targetId, weight]. */
  synapses: Array<[number, number, number]>;
}

/** Statistiques descriptives du réseau (outil OS « etat_reseau »). */
export interface ReseauStats {
  nbNeurones: number;
  nbSynapses: number;
  poidsMoyen: number;
  poidsMin: number;
  poidsMax: number;
  /** Histogramme des poids en 10 classes ([0.0,0.1), [0.1,0.2), ..., [0.9,1.0]). */
  histogramme: number[];
}

export class ReseauNeuronalGen3 {
  /** Neurones indexés par ID (0..size-1, ordre d'insertion stable). */
  neurones: Map<number, Neurone>;

  /** Synapses dirigées du réseau. */
  synapses: Synapse[];

  /** Taux d'apprentissage (plasticité non supervisée de step()). */
  learningRate: number;

  /** Configuration effective (remplacée uniquement par importState). */
  config: NeuralConfig;

  /**
   * INDEX INVERSE DES SYNAPSES (métabolisme cérébral, 2026-10-30) :
   * { idSource → synapses sortantes } — la transmission devient
   * ÉVÉNEMENTIELLE (coût ∝ spikes réels) au lieu de scanner toutes les
   * synapses à chaque pas. Reconstruit paresseusement : le test de longueur
   * capte TOUTE mutation topologique (genererConnexionsInitiales,
   * importState, importStateEtendu, pushes directs du trainer/runtime).
   */
  private indexSortants: Map<number, Synapse[]> | null = null;

  /** Longueur des synapses lors de la dernière construction de l'index. */
  private tailleIndexee = -1;

  /** Métabolisme du DERNIER pas exécuté (comptage exact, télémétrie honnête). */
  metabolismeDernierPas: MetabolismePas = {
    neuronesEvalues: 0,
    neuronesReposes: 0,
    spikes: 0,
    transmissions: 0,
    synapsesDenses: 0,
  };

  /** Métabolisme cumulé depuis la création / la dernière restauration. */
  metabolismeCumul: MetabolismeCumul = { ...METABOLISME_CUMUL_ZERO };

  constructor(config: Partial<NeuralConfig> = {}) {
    this.config = { ...NEURAL_CONFIG_DEFAUTS, ...config };
    this.neurones = new Map<number, Neurone>();
    for (let i = 0; i < this.config.size; i++) {
      this.neurones.set(
        i,
        new Neurone(i, this.config.defaultThreshold, this.config.defaultDecay),
      );
    }
    this.synapses = [];
    this.learningRate = this.config.learningRate;

    // Initialisation de connexions aléatoires (RNG seedé — adaptation (a)).
    this.genererConnexionsInitiales(this.config.density);
  }

  /**
   * Génération initiale des connexions (fidèle à la source) : pour chaque paire
   * src≠tgt, une synapse existe avec probabilité `density`, de poids uniforme
   * dans [0.1, 0.5]. Deux réseaux de même seed produisent des synapses
   * strictement identiques (ordre d'appel du RNG identique à la source :
   * tirage d'existence PUIS tirage du poids).
   */
  genererConnexionsInitiales(density: number): void {
    const rng = createRng(this.config.seed);
    const size = this.neurones.size;
    for (let src = 0; src < size; src++) {
      for (let tgt = 0; tgt < size; tgt++) {
        if (src !== tgt && rng() < density) {
          this.synapses.push(
            new Synapse(src, tgt, randUniform(rng, 0.1, 0.5)),
          );
        }
      }
    }
  }

  /**
   * Index inverse paresseux : reconstruit { idSource → synapses sortantes }
   * UNIQUEMENT quand la topologie a changé (longueur des synapses ≠ longueur
   * indexée). Chaque liste conserve l'ordre d'insertion global — la
   * transmission événementielle visite donc les synapses d'un même neurone
   * dans le même ordre relatif que le scan dense historique.
   */
  private obtenirIndexSortants(): Map<number, Synapse[]> {
    if (this.indexSortants && this.tailleIndexee === this.synapses.length) {
      return this.indexSortants;
    }
    const index = new Map<number, Synapse[]>();
    for (const synapse of this.synapses) {
      const sortantes = index.get(synapse.sourceId);
      if (sortantes) sortantes.push(synapse);
      else index.set(synapse.sourceId, [synapse]);
    }
    this.indexSortants = index;
    this.tailleIndexee = this.synapses.length;
    return index;
  }

  /** Copie défensive du métabolisme cumulé (télémétrie / API). */
  getMetabolisme(): MetabolismeCumul {
    return { ...this.metabolismeCumul };
  }

  /**
   * Un pas de temps dynamique dans le cerveau. ORDRE EXACT de la source :
   *  1. Injection des entrées externes (ex : du corps sémantique) ;
   *  2. Update des neurones → collecte des spikes ;
   *  3. Transmission le long des synapses dont la source a spike :
   *     la cible reçoit le poids, et la plasticité s'applique si la cible a
   *     spike dans la fenêtre (`currentTime - lastSpikeTime < plasticityWindow`)
   *     → weight = min(1, weight + learningRate).
   *
   * MÉTABOLISME CÉRÉBRAL (2026-10-30, fidélité préservée) — le coût suit
   * l'ACTIVITÉ réelle et plus la TAILLE du réseau, comme un cerveau
   * biologique (≈ 20 W pour 86 milliards de neurones) :
   *  - un neurone d'énergie nulle SANS stimulation est resté au repos :
   *    0 × (1 − decay) = 0 et aucun spike possible → évaluation sautée
   *    (strictement bit-à-bit équivalent : seule sa stateHistory — non
   *    utilisée en production — ne grossit plus) ;
   *  - la transmission est ÉVÉNEMENTIELLE via l'index inverse : seules les
   *    synapses des neurones spikés transmettent. Le résultat est identique
   *    au scan dense (chaque synapse spikée transmet exactement une fois,
   *    même poids, même plasticité ; le cumul par cible est commutatif).
   *
   * @returns Les IDs des neurones ayant spike pendant ce pas.
   */
  step(
    externalInputs: Record<number, number>,
    currentTime: number,
  ): number[] {
    // 1. Injection des entrées externes (ex: du corps sémantique)
    const stimules = new Set<number>();
    for (const idTexte of Object.keys(externalInputs)) {
      const neuroneId = Number(idTexte);
      const neurone = this.neurones.get(neuroneId);
      if (neurone) {
        neurone.receiveInput(externalInputs[neuroneId]);
        stimules.add(neuroneId);
      }
    }

    // 2. Update des neurones ACTIFS (repos biologique = coût zéro pour les
    //    neurones silencieux non stimulés).
    const spikedNeurones: number[] = [];
    let neuronesEvalues = 0;
    let neuronesReposes = 0;
    for (const [id, neurone] of this.neurones) {
      if (neurone.energy === 0 && !stimules.has(id)) {
        neuronesReposes += 1;
        continue;
      }
      neuronesEvalues += 1;
      if (neurone.updateState(currentTime)) {
        spikedNeurones.push(id);
      }
    }

    // 3. Transmettre l'énergie le long des synapses des neurones SPICÉS
    //    uniquement (propagation événementielle, index inverse).
    const index = this.obtenirIndexSortants();
    let transmissions = 0;
    for (const idSource of spikedNeurones) {
      const sortantes = index.get(idSource);
      if (!sortantes) continue;
      for (const synapse of sortantes) {
        const target = this.neurones.get(synapse.targetId);
        if (!target) continue;
        target.receiveInput(synapse.weight);
        synapse.lastActivation = currentTime;
        transmissions += 1;

        // Plasticité synaptique (Renforcement si la cible s'est activée récemment)
        const timeDiff = currentTime - target.lastSpikeTime;
        if (timeDiff < this.config.plasticityWindow) {
          // Fenêtre de plasticité
          synapse.weight = Math.min(1.0, synapse.weight + this.learningRate);
        }
      }
    }

    // Métabolisme : comptage EXACT du travail réel du pas.
    this.metabolismeDernierPas = {
      neuronesEvalues,
      neuronesReposes,
      spikes: spikedNeurones.length,
      transmissions,
      synapsesDenses: this.synapses.length,
    };
    this.metabolismeCumul.pas += 1;
    this.metabolismeCumul.neuronesEvalues += neuronesEvalues;
    this.metabolismeCumul.neuronesReposes += neuronesReposes;
    this.metabolismeCumul.spikes += spikedNeurones.length;
    this.metabolismeCumul.transmissions += transmissions;
    this.metabolismeCumul.transmissionsEvitees +=
      this.synapses.length - transmissions;

    return spikedNeurones;
  }

  /** Statistiques descriptives : compteurs, poids et histogramme (10 classes). */
  getStats(): ReseauStats {
    const nbSynapses = this.synapses.length;
    const histogramme = new Array<number>(10).fill(0);
    let somme = 0;
    let min = nbSynapses > 0 ? this.synapses[0].weight : 0;
    let max = nbSynapses > 0 ? this.synapses[0].weight : 0;
    for (const synapse of this.synapses) {
      const w = synapse.weight;
      somme += w;
      if (w < min) min = w;
      if (w > max) max = w;
      // Classe [w*10] bornée à 9 (un poids de exactement 1.0 tombe en classe 9).
      const classe = Math.min(9, Math.max(0, Math.floor(w * 10)));
      histogramme[classe] += 1;
    }
    return {
      nbNeurones: this.neurones.size,
      nbSynapses,
      poidsMoyen: nbSynapses > 0 ? somme / nbSynapses : 0,
      poidsMin: min,
      poidsMax: max,
      histogramme,
    };
  }

  /** Sérialise l'état structurel (config + synapses compactes). */
  exportState(): ReseauStateExport {
    return {
      config: { ...this.config },
      synapses: this.synapses.map(
        (s) => [s.sourceId, s.targetId, s.weight] as [number, number, number],
      ),
    };
  }

  /**
   * Restaure un état exporté : recrée les neurones selon la config puis les
   * synapses sérialisées. Les énergies repartent de zéro (seul le câblage
   * appris est persistant — les énergies sont par nature transitoires).
   *
   * SANITISATION (durcissement 2026-10-22) : toute synapse invalide est
   * rejetée AVANT restauration — poids non fini (NaN/Infinity : un neurone
   * ne spikerait plus jamais, amnésie silencieuse) ou identifiants hors
   * bornes (source/target < 0 ou ≥ size : synapse orpheline). Un avertissement
   * est loggé si des entrées sont écartées ; les synapses saines sont
   * restaurées à l'identique.
   */
  importState(state: ReseauStateExport): void {
    const config: NeuralConfig = {
      ...NEURAL_CONFIG_DEFAUTS,
      ...state.config,
    };
    this.neurones = new Map<number, Neurone>();
    for (let i = 0; i < config.size; i++) {
      this.neurones.set(
        i,
        new Neurone(i, config.defaultThreshold, config.defaultDecay),
      );
    }
    const brutes = Array.isArray(state.synapses) ? state.synapses : [];
    const valides: Array<[number, number, number]> = [];
    let rejetees = 0;
    for (const entree of brutes) {
      if (!Array.isArray(entree) || entree.length < 3) {
        rejetees++;
        continue;
      }
      const [sourceId, targetId, weight] = entree;
      if (
        !Number.isInteger(sourceId) ||
        !Number.isInteger(targetId) ||
        sourceId < 0 ||
        targetId < 0 ||
        sourceId >= config.size ||
        targetId >= config.size ||
        typeof weight !== "number" ||
        !Number.isFinite(weight)
      ) {
        rejetees++;
        continue;
      }
      valides.push([sourceId, targetId, weight]);
    }
    if (rejetees > 0) {
      console.warn(
        `[NEURAL] importState : ${rejetees} synapse(s) invalide(s) rejetée(s) sur ${brutes.length} (poids non fini ou identifiant hors bornes) — ${valides.length} restaurée(s).`,
      );
    }
    this.synapses = valides.map(
      ([sourceId, targetId, weight]) =>
        new Synapse(sourceId, targetId, weight),
    );
    this.learningRate = config.learningRate;
    this.config = config;
    // Restauration = nouveau départ métabolique : les compteurs décrivent
    // l'activité du processus courant, pas celle du cerveau restauré.
    this.indexSortants = null;
    this.tailleIndexee = -1;
    this.metabolismeDernierPas = {
      neuronesEvalues: 0,
      neuronesReposes: 0,
      spikes: 0,
      transmissions: 0,
      synapsesDenses: 0,
    };
    this.metabolismeCumul = { ...METABOLISME_CUMUL_ZERO };
  }

  /**
   * MIGRATION V3 — restaure un état persisté en l'étendant à `tailleCible`
   * neurones (ex. 100 → 140 pour la couche des 18 domaines). Garanties :
   *  - les synapses appris du cerveau historique sont restaurées À
   *    L'IDENTIQUE (aucune re-génération, aucune perte) ;
   *  - les nouveaux neurones (ancienne taille .. tailleCible-1) sont créés
   *    et câblés déterministiquement (flux RNG dédié seed `config.seed +
   *    7919` — indépendant du câblage initial) pour que la migration d'un
   *    même fichier produise toujours le même réseau ;
   *  - l'ordre d'insertion des neurones reste 0..tailleCible-1.
   */
  importStateEtendu(state: ReseauStateExport, tailleCible: number): void {
    // 1. Restauration fidèle de l'état historique.
    this.importState(state);
    if (tailleCible <= this.config.size) return;

    const ancienneTaille = this.config.size;
    const config: NeuralConfig = { ...this.config, size: tailleCible };

    // 2. Création des neurones manquants (même seuil/décroissance).
    for (let i = ancienneTaille; i < tailleCible; i++) {
      this.neurones.set(
        i,
        new Neurone(config.defaultThreshold, config.defaultDecay),
      );
    }

    // 3. Câblage initial des nouveaux neurones : chaque paire impliquant au
    //    moins un neurone nouveau reçoit sa synapse initiale selon la même
    //    règle que genererConnexionsInitiales (probabilité density, poids
    //    uniforme [0.1, 0.5]) — mais via un flux RNG DÉDIÉ (seed + 7919)
    //    pour rester indépendant du câblage historique ET reproductible.
    const existantes = new Set(
      this.synapses.map((s) => `${s.sourceId}->${s.targetId}`),
    );
    const rng = createRng(config.seed + 7919);
    for (let src = 0; src < tailleCible; src++) {
      const srcNouveau = src >= ancienneTaille;
      for (let tgt = 0; tgt < tailleCible; tgt++) {
        if (src === tgt) continue;
        if (!srcNouveau && tgt < ancienneTaille) continue;
        // Même ordre que genererConnexionsInitiales : tirage d'existence
        // PUIS tirage du poids.
        if (rng() >= config.density) continue;
        const cle = `${src}->${tgt}`;
        if (existantes.has(cle)) continue;
        this.synapses.push(new Synapse(src, tgt, randUniform(rng, 0.1, 0.5)));
        existantes.add(cle);
      }
    }

    this.config = config;
    this.learningRate = config.learningRate;
  }
}
