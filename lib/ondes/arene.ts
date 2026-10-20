/**
 * ARÈNE D'INTERFÉRENCE — l'accélérateur de particules pour IA.
 *
 * Deux IA (un PROFESSEUR et un ÉLÈVE, ou deux modèles d'utilisateurs)
 * traduisent leurs réponses en ondes via le codec (`lib/ondes/codec.ts`)
 * et les injectent dans deux champs physiquement IDENTIQUES (même grille,
 * même carte de fréquences propres — graine 42, même physique de
 * propagation). La corrélation de leurs idées devient alors une GRANDEUR
 * PHYSIQUE mesurable :
 *
 *    E(ψa + ψb) = E(ψa) + E(ψb) + 2·⟨ψa, ψb⟩
 *                            └────────┬────────┘
 *                    terme d'interférence = produit scalaire physique
 *
 *  - Idées d'accord → résonance CONSTRUCTIVE : les ondes s'amplifient,
 *    le signal devient lumineux et fort, le paramètre d'ordre de
 *    Kuramoto monte — la logique de l'élève est validée ;
 *  - Idées opposées → interférence DESTRUCTIVE : les ondes s'annulent,
 *    le champ s'éteint — l'élève détecte instantanément son erreur.
 *
 * L'APPRENTISSAGE PAR RESSenti PHYSIQUE (physics-guided reinforcement)
 * s'appuie sur cet état physique comme unique signal de récompense —
 * aucun algorithme de récompense symbolique, aucune loss : l'onde JUGE.
 * Le renforcement et la distillation sont réalisés par les ondes
 * elles-mêmes (plasticité d'usage du cortex élève + renforcement
 * hebbien des régions fréquentielles — le « ressenti » persiste dans la
 * carte de fréquences du champ élève).
 */

import { CortexLangagierGen3 } from "@/lib/neural/generation/language";
import type { PaireLangage } from "@/lib/neural/generation/corpus";

import { MoteurCpu, type MoteurOndes } from "./champ";
import { texteVersVecteur, vecteurVersImpulsions } from "./codec";
import { EvolutionOndes } from "./evolution";
import type { ConfigOndes, Impulsion } from "./types";

/** Grille de l'arène — 128² : assez dense pour l'interférence, rapide en CPU. */
export const DIM_ARENE = 128;

/** Nombre de pas de propagation avant la mesure d'interférence. */
export const PAS_PROPAGATION = 3;

/** Mesures physiques d'un duel d'interférence. */
export interface MesuresInterference {
  /** Cosinus physique ⟨ψa, ψb⟩ / ‖ψa‖‖ψb‖ ∈ [-1, 1] — l'accord des idées. */
  correlation: number;
  /** Gain d'énergie par interférence constructive ∈ [0, 1]. */
  resonance: number;
  /** Perte d'énergie par interférence destructive ∈ [0, 1]. */
  annihilation: number;
  /** Récompense physique = resonance − annihilation ∈ [-1, 1]. */
  reward: number;
  /** Paramètre d'ordre de Kuramoto moyen des deux champs (synchronisation). */
  coherence: number;
  /** Énergies brutes (diagnostic). */
  energieA: number;
  energieB: number;
  energieSomme: number;
}

/** Verdict physique d'un round. */
export type VerdictArene = "resonance" | "neutre" | "annihilation";

/** Seuils de verdict (en reward). */
export const SEUIL_RESONANCE = 0.2;
export const SEUIL_ANNIHILATION = -0.2;

/**
 * L'arène : deux champs identiques, une physique, un verdict.
 * Réutilisable round après round (les champs sont réinitialisés entre
 * les duels — chaque duel part d'un milieu neuf, seule la carte de
 * fréquences propres persiste, portée par l'évolution hebbienne).
 */
export class AreneInterference {
  private readonly cfg: ConfigOndes;

  constructor(cfg?: Partial<ConfigOndes>) {
    this.cfg = {
      largeur: DIM_ARENE,
      hauteur: DIM_ARENE,
      pasParImage: 1,
      periodeReadback: 1,
      c2: 0.25,
      amortissement: 0.985,
      couplage: 0.1,
      dt: 0.12,
      gain: 0.016,
      ...cfg,
    };
  }

  /** Configuration physique de l'arène (réutilisée par les champs). */
  get configuration(): ConfigOndes {
    return { ...this.cfg };
  }

  /**
   * Duel d'ondes brutes : deux séries d'impulsions sont propagées dans
   * deux champs identiques, puis l'interférence est mesurée sur les
   * amplitudes signées. C'est la primitive physique — les duels de
   * textes et de vecteurs s'appuient dessus.
   */
  duelImpulsions(a: Impulsion[], b: Impulsion[]): MesuresInterference {
    const champA = this.creerChamp();
    const champB = this.creerChamp();
    try {
      champA.injecter(a);
      champB.injecter(b);
      for (let k = 0; k < PAS_PROPAGATION; k++) {
        champA.avancer();
        champB.avancer();
      }
      return this.mesurer(champA, champB);
    } finally {
      champA.detruire();
      champB.detruire();
    }
  }

  /** Duel de vecteurs : deux IA parlent directement en nombres. */
  duelVecteurs(vA: ArrayLike<number>, vB: ArrayLike<number>): MesuresInterference {
    const a = vecteurVersImpulsions(vA, DIM_ARENE);
    const b = vecteurVersImpulsions(vB, DIM_ARENE);
    return this.duelImpulsions(a, b);
  }

  /**
   * Duel de textes avec exposition des champs — variante du duel de
   * textes qui remet les amplitudes des deux champs propagés à l'observateur
   * (l'interface peint ainsi la résonance en temps réel). Les champs sont
   * des copies flottantes : le duel reste sans état de fond.
   */
  duelTextesAvecChamps(
    texteA: string,
    texteB: string,
    observateur?: (amplitudesA: Float32Array, amplitudesB: Float32Array) => void,
  ): MesuresInterference {
    const composantes = 1024;
    const a = vecteurVersImpulsions(texteVersVecteur(texteA, composantes), DIM_ARENE);
    const b = vecteurVersImpulsions(texteVersVecteur(texteB, composantes), DIM_ARENE);
    const champA = this.creerChamp();
    const champB = this.creerChamp();
    try {
      champA.injecter(a);
      champB.injecter(b);
      for (let k = 0; k < PAS_PROPAGATION; k++) {
        champA.avancer();
        champB.avancer();
      }
      if (observateur) observateur(champA.amplitudes().slice(), champB.amplitudes().slice());
      return this.mesurer(champA, champB);
    } finally {
      champA.detruire();
      champB.detruire();
    }
  }

  /**
   * Duel de textes : la langue naturelle franchit le pont — chaque texte
   * est projeté en vecteur (sac de mots dense signé) puis en ondes.
   * Deux textes qui « disent la même chose » résonnent ; deux textes qui
   * se contredisent s'annihilent. La dimension 1024 réduit les collisions
   * de hachage : l'interférence résiduelle entre textes sans mots communs
   * reste au bruit de fond.
   */
  duelTextes(texteA: string, texteB: string): MesuresInterference {
    const composantes = 1024;
    return this.duelVecteurs(texteVersVecteur(texteA, composantes), texteVersVecteur(texteB, composantes));
  }

  /** Mesure l'interférence entre deux champs déjà propagés. */
  private mesurer(champA: MoteurOndes, champB: MoteurOndes): MesuresInterference {
    const a = champA.amplitudes();
    const b = champB.amplitudes();
    let pa = 0;
    let pb = 0;
    let pab = 0;
    for (let i = 0; i < a.length; i++) {
      pa += a[i] * a[i];
      pb += b[i] * b[i];
      pab += a[i] * b[i];
    }
    const correlation = pa > 0 && pb > 0 ? pab / Math.sqrt(pa * pb) : 0;
    const total = pa + pb;
    // E(a+b) = pa + pb + 2·pab → ratio d'énergie de superposition.
    const ratio = total > 0 ? (total + 2 * pab) / total : 1;
    const resonance = Math.max(0, Math.min(1, ratio - 1));
    const annihilation = Math.max(0, Math.min(1, 1 - ratio));
    const reward = Math.max(-1, Math.min(1, resonance - annihilation));

    return {
      correlation,
      resonance,
      annihilation,
      reward,
      coherence: coherenceOrdonne(champA, champB),
      energieA: pa,
      energieB: pb,
      energieSomme: total + 2 * pab,
    };
  }

  /** Crée un champ vierge aux paramètres de l'arène (graine 42 incluse). */
  creerChamp(): MoteurCpu {
    return new MoteurCpu(this.cfg);
  }
}

/** Paramètre d'ordre de Kuramoto moyen des deux champs. */
function coherenceOrdonne(champA: MoteurOndes, champB: MoteurOndes): number {
  const ordre = (champ: MoteurOndes): number => {
    const phases = champ.phases();
    let cos = 0;
    let sin = 0;
    const pas = Math.max(1, Math.floor(phases.length / 4096));
    let n = 0;
    for (let i = 0; i < phases.length; i += pas) {
      cos += Math.cos(phases[i]);
      sin += Math.sin(phases[i]);
      n++;
    }
    return n > 0 ? Math.hypot(cos, sin) / n : 0;
  };
  return (ordre(champA) + ordre(champB)) / 2;
}

/* ------------------------------------------------------------------ */
/* ENTRAÎNEMENT PAR RÉSONANCE — physics-guided reinforcement           */
/* ------------------------------------------------------------------ */

/** Action appliquée à l'élève à l'issue d'un round. */
export type ActionRound = "renforcee" | "distillee" | "ignoree";

/** Résultat d'un round d'entraînement. */
export interface ResultatRound {
  motif: string;
  reponseProfesseur: string;
  reponseEleve: string | null;
  mesures: MesuresInterference;
  verdict: VerdictArene;
  action: ActionRound;
}

/** Rapport complet d'une session d'entraînement par résonance. */
export interface RapportEntrainement {
  rounds: ResultatRound[];
  renforcees: number;
  distillees: number;
  ignorees: number;
  /** Reward physique moyen des rounds où l'élève a parlé. */
  rewardMoyen: number;
  /** Reward moyen des 5 premiers vs 5 derniers rounds parlés — la progression. */
  progression: number;
  /** État du cortex élève après entraînement (exportable/persistable). */
  etatEleve: ReturnType<CortexLangagierGen3["exporterEtat"]>;
}

export interface OptionsEntrainement {
  /** Reward au-delà duquel la réponse de l'élève est renforcée. */
  seuilResonance?: number;
  /** Corrélation brute minimale pour parler de résonance (anti-bruit). */
  seuilCorrelation?: number;
  /** Reward en deçà duquel la réponse de l'élève est corrigée. */
  seuilAnnihilation?: number;
  /** Taux de renforcement hebbien du champ élève (ressenti physique). */
  etaInitial?: number;
}

/**
 * Entraîne un modèle ÉLÈVE par interférence avec un modèle PROFESSEUR.
 *
 * Chaque round :
 *  1. le professeur répond au motif (l'arène ne juge que ce que le
 *     professeur SAIT — sinon le round est ignoré, sans invention) ;
 *  2. l'élève répond de son côté ;
 *  3. les deux réponses deviennent des ondes, s'interfèrent, la
 *     physique rend son verdict ;
 *  4. résonance → la plasticité d'usage du cortex élève a déjà
 *     renforcé la paire rappelée, et le renforcement hebbien grave
 *     l'empreinte fréquentielle dans le champ élève (ressenti positif) ;
 *  5. annihilation → DISTILLATION PAR ONDES : la réponse du professeur
 *     est injectée dans le champ élève comme onde d'enseignement (les
 *     régions correspondantes voient leur fréquence propre dériver vers
 *     celle de l'onde — le champ « ressent » la correction) et la paire
 *     motif → réponse du professeur est apprise par l'élève.
 */
export class EntrainementParResonance {
  private readonly arene: AreneInterference;
  private readonly evolution: EvolutionOndes;
  private readonly seuilResonance: number;
  private readonly seuilCorrelation: number;
  private readonly seuilAnnihilation: number;
  /** Carte de fréquences du champ élève — la MÉMOIRE physique persistante. */
  private frequencesEleve: Float32Array;

  constructor(
    private readonly professeur: CortexLangagierGen3,
    private readonly eleve: CortexLangagierGen3,
    options?: OptionsEntrainement,
  ) {
    this.arene = new AreneInterference();
    this.evolution = new EvolutionOndes(0.1, 0.985, {
      etaInitial: options?.etaInitial ?? 0.012,
    });
    this.seuilResonance = options?.seuilResonance ?? SEUIL_RESONANCE;
    this.seuilCorrelation = options?.seuilCorrelation ?? 0.35;
    this.seuilAnnihilation = options?.seuilAnnihilation ?? SEUIL_ANNIHILATION;
    this.frequencesEleve = this.arene.creerChamp().frequences().slice();
  }

  /**
   * Un round d'entraînement : duel physique + renforcement/distillation.
   * Le champ élève est réellement propagé pendant l'enseignement : les
   * régions touchées par l'onde du professeur voient leur fréquence
   * propre évoluer (persistance de l'apprentissage dans la matière).
   *
   * @param observateur reçu avec les amplitudes des deux champs propagés
   *        (visualisation de l'interférence — l'interface n'a aucune
   *        logique propre : elle observe).
   */
  round(motif: string, observateur?: (amplitudesProf: Float32Array, amplitudesEleve: Float32Array) => void): ResultatRound {
    const reponseProf = this.professeur.repondre(motif);
    if (reponseProf === null || !reponseProf.texte.trim()) {
      // Le professeur ne sait pas : l'arène ne juge pas (honnêteté).
      return {
        motif,
        reponseProfesseur: "",
        reponseEleve: null,
        mesures: mesuresNeutres(),
        verdict: "neutre",
        action: "ignoree",
      };
    }

    const reponseEleve = this.eleve.repondre(motif);
    const texteEleve = reponseEleve?.texte ?? "";
    const mesures = observateur
      ? this.arene.duelTextesAvecChamps(reponseProf.texte, texteEleve, observateur)
      : this.arene.duelTextes(reponseProf.texte, texteEleve);

    if (texteEleve && mesures.reward >= this.seuilResonance && mesures.correlation >= this.seuilCorrelation) {
      // Résonance : la logique de l'élève est VALIDÉE par la physique.
      // La plasticité d'usage (cortex) a renforcé la paire au rappel ;
      // le ressenti hebbien grave l'empreinte dans le champ élève.
      this.ressentir(reponseProf.texte, +1);
      return { motif, reponseProfesseur: reponseProf.texte, reponseEleve: texteEleve, mesures, verdict: "resonance", action: "renforcee" };
    }

    // Ni résonance (signal faible, neutre ou annihilation) ni silence du
    // professeur : l'élève répond à côté — DISTILLATION PAR ONDES. La
    // physique fait le tri : seul un signal physiquement fort échappe
    // à la correction (l'annihilation parfaite reste mesurée et tracée
    // dans `mesures`).
    const verdict = mesures.reward <= this.seuilAnnihilation ? "annihilation" : "neutre";
    // Rééducation si l'élève connaissait le motif avec une mauvaise
    // réponse, apprentissage neuf sinon (motif inconnu de l'élève).
    if (!this.eleve.reeducer(motif, reponseProf.texte, reponseProf.theme)) {
      this.eleve.apprendre(
        [{ motif, reponse: reponseProf.texte, theme: reponseProf.theme } satisfies PaireLangage],
        { personnalisees: true },
      );
    }
    this.ressentir(reponseProf.texte, -1);
    return { motif, reponseProfesseur: reponseProf.texte, reponseEleve: texteEleve || null, mesures, verdict, action: "distillee" };
  }

  /**
   * Session complète : N motifs, un rapport. Les motifs peuvent être
   * fournis par l'appelant (questions du dataset, paires du modèle…) ;
   * s'ils sont absents, ce sont les motifs des paires de l'élève.
   */
  entrainer(motifs: string[]): RapportEntrainement {
    const rounds: ResultatRound[] = [];
    for (const motif of motifs) {
      if (!motif.trim()) continue;
      rounds.push(this.round(motif));
    }
    const parles = rounds.filter((r) => r.action !== "ignoree" || r.reponseEleve !== null);
    const rewards = parles.map((r) => r.mesures.reward);
    const rewardMoyen = rewards.length > 0 ? rewards.reduce((s, v) => s + v, 0) / rewards.length : 0;
    const tete = rewards.slice(0, 5);
    const queue = rewards.slice(-5);
    const moyenne = (xs: number[]): number => (xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
    const progression = tete.length > 0 && queue.length > 0 ? moyenne(queue) - moyenne(tete) : 0;

    return {
      rounds,
      renforcees: rounds.filter((r) => r.action === "renforcee").length,
      distillees: rounds.filter((r) => r.action === "distillee").length,
      ignorees: rounds.filter((r) => r.action === "ignoree").length,
      rewardMoyen,
      progression,
      etatEleve: this.eleve.exporterEtat(),
    };
  }

  /**
   * Le RESSenti PHYSIQUE : la réponse du professeur est injectée comme
   * onde dans le champ élève, les régions résonantes voient leur
   * fréquence propre évoluer via l'évolution hebbienne, et la carte
   * modifiée est réécrite dans le champ élève (persistance).
   *
   * @param sens +1 (validation — l'onde amplifie) / −1 (correction —
   *             l'onde d'enseignement s'impose au champ)
   */
  private ressentir(enseignement: string, sens: number): void {
    const champ = this.arene.creerChamp();
    try {
      champ.remplacerFrequences(this.frequencesEleve);
      champ.injecter(vecteurVersImpulsions(texteVersVecteur(enseignement, 256), DIM_ARENE));
      for (let k = 0; k < PAS_PROPAGATION + 2; k++) champ.avancer();
      const lecture = lireChampCpu(champ);
      this.evolution.definirDimension(DIM_ARENE);
      this.evolution.evoluer({ ordreR: lecture.ordreR, energie: lecture.energie, pics: lecture.pics, pas: PAS_PROPAGATION + 2 });
      this.evolution.appliquer(champ.frequences(), DIM_ARENE);
      // Le sens module la conservation : une validation préserve plus de
      // l'état antérieur (dérive douce), une correction dérive davantage.
      const precedent = this.frequencesEleve;
      const nouveau = champ.frequences();
      const conservation = sens > 0 ? 0.75 : 0.45;
      for (let i = 0; i < nouveau.length; i++) {
        nouveau[i] = precedent[i] * conservation + nouveau[i] * (1 - conservation);
      }
      this.frequencesEleve = nouveau;
    } finally {
      champ.detruire();
    }
  }

  /** Empreinte fréquentielle actuelle du champ élève (mémoire physique). */
  get memoireFrequentielle(): Float32Array {
    return this.frequencesEleve;
  }

  /** État courant du cortex élève (exportable à tout instant). */
  get etatEleve(): ReturnType<CortexLangagierGen3["exporterEtat"]> {
    return this.eleve.exporterEtat();
  }

  /** Configuration physique de l'arène sous-jacente. */
  get configurationArene(): ConfigOndes {
    return this.arene.configuration;
  }
}

/** Mesures neutres (rounds ignorés — le professeur ne savait pas). */
function mesuresNeutres(): MesuresInterference {
  return {
    correlation: 0,
    resonance: 0,
    annihilation: 0,
    reward: 0,
    coherence: 0,
    energieA: 0,
    energieB: 0,
    energieSomme: 0,
  };
}

/**
 * Lecture synchrone d'un champ CPU (pics, ordre, énergie) — l'arène
 * serveur n'attend jamais de barrière GPU : le readback est direct.
 */
function lireChampCpu(champ: MoteurOndes): { pics: Array<{ x: number; y: number; amplitude: number; phase: number }>; ordreR: number; energie: number } {
  const amplitudes = champ.amplitudes();
  const phases = champ.phases();
  const w = champ.largeur;
  const h = champ.hauteur;
  const pics: Array<{ x: number; y: number; amplitude: number; phase: number }> = [];
  let sommeCos = 0;
  let sommeSin = 0;
  let energieSomme = 0;
  let echantillons = 0;
  for (let y = 2; y < h - 2; y += 2) {
    for (let x = 2; x < w - 2; x += 2) {
      const i = y * w + x;
      const a = Math.abs(amplitudes[i]);
      energieSomme += a;
      sommeCos += Math.cos(phases[i]);
      sommeSin += Math.sin(phases[i]);
      echantillons++;
      if (a < 0.35) continue;
      if (
        a >= Math.abs(amplitudes[i - 1]) &&
        a >= Math.abs(amplitudes[i + 1]) &&
        a >= Math.abs(amplitudes[i - w]) &&
        a > Math.abs(amplitudes[i + w])
      ) {
        pics.push({ x, y, amplitude: a, phase: phases[i] });
      }
    }
  }
  pics.sort((p1, p2) => p2.amplitude - p1.amplitude);
  return {
    pics: pics.slice(0, 12),
    ordreR: echantillons > 0 ? Math.hypot(sommeCos, sommeSin) / echantillons : 0,
    energie: echantillons > 0 ? energieSomme / echantillons : 0,
  };
}
