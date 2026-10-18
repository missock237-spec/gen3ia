/**
 * NOYAU CENTRAL GEN3 — portage fidèle de la classe `NoyauCentralGen3`
 * de la source Python (Noyau Central.pdf).
 *
 * Orchestre chaque cycle complet du système :
 *  1. Transit et aiguillage des informations (Requête vs Veille) ;
 *  2. Évolution et propagation au sein du noyau neuronal ;
 *  3. Vérification de la santé et homéostasie ;
 *  4. Interrogation des effecteurs du corps sémantique.
 *
 * ADAPTATIONS documentées par rapport à la source Python :
 *  (b) HORLOGE VIRTUELLE : la source appelait `time.time()` — temps réel non
 *      déterministe qui rendait les fenêtres de plasticité dépendantes de
 *      l'heure. Ici, `time` avance de +1.0 unité à chaque exécution de cycle :
 *      les fenêtres de plasticité (2.0 par défaut) couvrent exactement les
 *      2 derniers cycles, de façon déterministe.
 *  (c) Entrées directes : `inputsDirects` permet d'injecter un vecteur
 *      d'énergie (encodage de texte, zone 0..37) en plus du canal résonant —
 *      nécessaire au moteur neuronal pour encoder un prompt. La mécanique
 *      du canal (injection « utilisateur_in » à 1.5 par défaut) reste
 *      strictement celle de la source.
 *
 * Les prints Python deviennent des console.log discrets préfixés [NEURAL].
 *
 * Module PUR — aucune dépendance Node.
 */

import { CANAL_UTILISATEUR_IN } from "./types";
import type {
  CycleReport,
  Effecteur,
  EffectorActionResult,
  HealthMetrics,
} from "./types";
import type { ReseauNeuronalGen3 } from "./network";
import type { EspaceFiltreResonant } from "./resonant-space";
import type { GenerateurAutoOscillation } from "./auto-oscillation";

/**
 * Requête externe adressée au noyau (adaptation (c) : `inputsDirects`
 * complète le couple canal/intensité de la source).
 */
export interface RequeteExterne {
  /** Canal d'entrée (défaut : « utilisateur_in »). */
  canal?: string;
  /** Intensité d'injection sur le canal (défaut : 1.5, comme la source). */
  intensite?: number;
  /**
   * Entrées neuronales directes { idNeurone: énergie } — typiquement
   * l'encodage de texte sur la zone de tokens (0..37). Injectées dans
   * step() en plus du canal.
   */
  inputsDirects?: Record<number, number>;
}

export class NoyauCentralGen3 {
  /** Le cerveau (réseau de neurones). */
  readonly cerveau: ReseauNeuronalGen3;

  /** Espace d'entrée-sortie résonant (canaux ↔ pools de neurones). */
  readonly ioResonant: EspaceFiltreResonant;

  /** Moteur d'auto-oscillation (veille / rêve). */
  readonly veilleMoteur: GenerateurAutoOscillation;

  /** Composants du corps sémantique enregistrés (effecteurs). */
  effecteurs: Effecteur[];

  /**
   * Métriques de santé et de suivi évolutif — mêmes champs que la source
   * Python (`metriques_sante`), mode initial « VEILLE ».
   */
  metriquesSante: HealthMetrics;

  /**
   * Horloge virtuelle interne (adaptation (b)) : avance de +1.0 unité à chaque
   * cycle exécuté. Temps de référence des fenêtres de plasticité.
   */
  time: number;

  constructor(
    cerveau: ReseauNeuronalGen3,
    ioResonant: EspaceFiltreResonant,
    veilleMoteur: GenerateurAutoOscillation,
    effecteurs: Effecteur[] = [],
  ) {
    this.cerveau = cerveau;
    this.ioResonant = ioResonant;
    this.veilleMoteur = veilleMoteur;
    this.effecteurs = effecteurs;
    this.time = 0;

    // Métriques de santé et de suivi évolutif
    this.metriquesSante = {
      cyclesTotaux: 0,
      energieMoyenne: 0.0,
      indiceHomeostasie: 1.0,
      modeActuel: "VEILLE",
    };
  }

  /** Ajoute un composant du corps sémantique à l'orchestration globale. */
  enregistrerEffecteur(effecteur: Effecteur): void {
    this.effecteurs.push(effecteur);
  }

  /**
   * Surveille et régule l'état de santé du cerveau neuronal en continu.
   * Empêche l'explosion d'énergie (emballement) ou l'inertie totale (mort
   * synaptique). LOGIQUE EXACTE de la source :
   *  - énergie moyenne > 0.75 → atténuation douce de toutes les énergies
   *    (× 0.85) et indice d'homéostasie 0.75 (alerte surcharge) ;
   *  - énergie moyenne < 0.015 → injection d'un micro-tonus vital (0.15) au
   *    premier 1/5 des neurones et indice 0.90 (relance douce) ;
   *  - sinon → indice 1.0 (équilibre parfait).
   */
  verifierSanteNeuronale(): void {
    const energies = Array.from(
      this.cerveau.neurones.values(),
      (n) => n.energy,
    );
    const energieMoy =
      energies.length > 0
        ? energies.reduce((a, b) => a + b, 0) / energies.length
        : 0.0;
    this.metriquesSante.energieMoyenne = energieMoy;

    if (energieMoy > 0.75) {
      // Emballement détecté : atténuation douce pour stabiliser le réseau
      for (const neurone of this.cerveau.neurones.values()) {
        neurone.energy *= 0.85;
      }
      this.metriquesSante.indiceHomeostasie = 0.75; // Alerte surcharge
    } else if (energieMoy < 0.015) {
      // Stagnation / Extinction détectée : injection d'un micro-tonus vital
      // au premier cinquième des neurones (ordre d'insertion, cf. source).
      const limite = Math.floor(this.cerveau.neurones.size / 5);
      let injectes = 0;
      for (const neurone of this.cerveau.neurones.values()) {
        if (injectes >= limite) break;
        neurone.receiveInput(0.15);
        injectes += 1;
      }
      this.metriquesSante.indiceHomeostasie = 0.9; // Relance douce
    } else {
      this.metriquesSante.indiceHomeostasie = 1.0; // Équilibre parfait
    }
  }

  /**
   * Exécute un cycle complet géré par le noyau central :
   *  1. Transit et aiguillage des informations (Requête vs Veille) ;
   *  2. Évolution et propagation au sein du noyau neuronal ;
   *  3. Vérification de la santé et homéostasie ;
   *  4. Interrogation des effecteurs du corps sémantique.
   *
   * @param requeteExterne Requête optionnelle (canal, intensité, entrées directes).
   * @param contexteGlobal Contexte transmis aux effecteurs (commande d'outil,
   *        paramètres média...) — jamais utilisé par le noyau lui-même.
   */
  executerCycle(
    requeteExterne?: RequeteExterne,
    contexteGlobal?: Record<string, unknown>,
  ): CycleReport {
    this.metriquesSante.cyclesTotaux += 1;

    // Adaptation (b) : horloge virtuelle, +1.0 unité par cycle exécuté.
    this.time += 1.0;
    const currentTime = this.time;

    const contexte = contexteGlobal ?? {};

    // 1. Gestion du transit des informations
    let spikedNeurons: number[];
    if (requeteExterne) {
      this.metriquesSante.modeActuel = "TRAITEMENT_REQUETE";
      const canal = requeteExterne.canal ?? CANAL_UTILISATEUR_IN;
      const intensite = requeteExterne.intensite ?? 1.5;

      // Transit via l'espace résonant
      this.ioResonant.injectSignal(this.cerveau, canal, intensite);

      // Adaptation (c) : entrées directes (encodage de texte) en plus du canal.
      spikedNeurons = this.cerveau.step(
        requeteExterne.inputsDirects ?? {},
        currentTime,
      );
    } else {
      // Pas de requête : le noyau bascule le système en auto-oscillation
      // (Veille / Rêve continu)
      this.metriquesSante.modeActuel = "AUTO_OSCILLATION_VEILLE";
      spikedNeurons = this.veilleMoteur.simulerVeille(currentTime);
    }

    // 2. Vérification et maintien de la santé neuronale
    this.verifierSanteNeuronale();

    // 3. Transit des ordres vers le corps sémantique (Écoute des résonances)
    const actionsDeclenchees: EffectorActionResult[] = [];
    for (const effecteur of this.effecteurs) {
      const resultatsEffecteur = effecteur.evaluerEtExecuter(
        spikedNeurons,
        contexte,
      );
      if (resultatsEffecteur.length > 0) {
        actionsDeclenchees.push(...resultatsEffecteur);
      }
    }

    // Rapport du cycle (copie défensive des métriques : le dictionnaire
    // Python était retourné par référence, ici on fige un instantané).
    return {
      cycle: this.metriquesSante.cyclesTotaux,
      mode: this.metriquesSante.modeActuel,
      spikedNeurones: spikedNeurons,
      neuronesActifs: spikedNeurons.length,
      sante: { ...this.metriquesSante },
      actionsCorps: actionsDeclenchees,
    };
  }
}
