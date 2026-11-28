/**
 * SYSTÈME NEURO-ONDES UNIFIÉ (SNOU) — recommandation du propriétaire.
 *
 * « Le système neuronal et le système de mémoire doivent être UN SEUL
 *  système qui fonctionne ensemble » : il n'y a plus de mémoire séparée du
 *  réseau — les données fournies par l'utilisateur sont mémorisées DANS le
 *  champ d'ondes neuronal (bandes mnémoniques = paquets d'ondes commis) et
 *  la lecture de mémoire EST un calcul neuronal : les paquets commis sont
 *  RÉINJECTÉS dans le même substrat physique, où ils interfèrent avec les
 *  ondes de la requête courante. Gen3 comprend ainsi les intentions et le
 *  monde par RÉSONANCE avec tout ce qu'il a vécu, pas par une consultation
 *  de table externe.
 *
 *  · écriture : encodeur multimodal unifié → impulsions dans le champ →
 *    propagation → COMMIT du paquet (journal d'ondes = mémoire) ;
 *  · lecture : requête injectée → pour chaque souvenir candidat, un CLONE
 *    déterministe du même substrat (mêmes fréquences propres, graine 42)
 *    reçoit requête + souvenir → mesure du GAIN DE RÉSONANCE (relatif au
 *    pic de base de la requête seule), de la LATENCE du pic et de
 *    l'ALIGNEMENT DE PHASE → attention spike-driven ;
 *  · isolement multi-utilisateur : un champ par clé (userId|conversation),
 *    même doctrine P0 que l'hippocampe (fenêtres distinctes) ;
 *  · le texte source accompagne le paquet (la forme) — le SENS est l'onde.
 *
 * Physique réelle : d'Alembert discrétisé + couplage de Kuramoto
 * (lib/ondes/champ.ts — implémentation miroir du shader WGSL).
 */

import { MoteurCpu } from "@/lib/ondes/champ";
import type { Impulsion, Pic } from "@/lib/ondes/types";

import { attentionSpikeDriven, type PoidsAttention, type TraceMnemonique } from "./attention-spike-driven";
import { encoderEntreeMultimodale, projeterConcept, canonicaliserConcept, hacherConcept, positionDepuisHachage, FREQUENCE_MAX, FREQUENCE_MIN, type Modalite } from "./encodeur-multimodal-unifie";

/** Configuration physique du champ de fusion (grille compacte serveur). */
export const CONFIG_FUSION = {
  largeur: 64,
  hauteur: 48,
  pasParImage: 1,
  periodeReadback: 1,
  c2: 0.25,
  amortissement: 0.95,
  couplage: 0.12,
  dt: 0.1,
  gain: 1.05,
} as const;

/** Pas de propagation après une écriture (gravure de la bande mnémonique). */
const PAS_GRAVURE = 6;
/** Pas mesurés par souvenir pour détecter la latence du pic. */
const PAS_MESURE = 8;
/** Plafond de souvenirs par champ (éviction du plus ancien). */
export const MAX_TRACES = 200;
/** Souvenirs candidats maximaux mesurés par compréhension. */
const MAX_CANDIDATS = 24;
/** Seuil d'attention du souvenir dominant (softmax). */
export const SEUIL_DOMINANT = 0.5;

/** Un souvenir commis dans le champ : le paquet d'ondes EST la mémoire. */
export interface TraceOnde extends TraceMnemonique {
  concepts: string[];
}

export interface OptionsUtilisateur {
  userId?: string;
  conversationId?: string;
}

export interface ResultatMemorisation {
  traceId: string;
  impulsions: number;
  concepts: string[];
  pasTotaux: number;
}

export interface ResonanceMemoire {
  traceId: string;
  poids: number;
  gain: number;
  latencePic: number;
  /** Extrait du souvenir qui résonne (télémétrie, tronqué). */
  extrait: string;
}

export interface ComprehensionOndes {
  /** Souvenirs qui résonnent avec la requête (triés par poids). */
  resonances: ResonanceMemoire[];
  /** Souvenir dominant s'il dépasse le seuil d'attention. */
  souvenirDominant: ResonanceMemoire | null;
  /** Paramètre d'ordre de Kuramoto du champ après requête. */
  ordreR: number;
  /** Énergie moyenne du champ après requête. */
  energie: number;
  /** Nombre de souvenirs commis dans ce champ (mémoire vivante). */
  tailleMemoire: number;
}

/** Extraction lexicale déterministe des concepts d'un texte. */
export function extraireConcepts(texte: string, plafond = 12): string[] {
  const mots = canonicaliserConcept(texte).split(" ").filter((m) => m.length >= 3);
  return [...new Set(mots)].slice(0, plafond);
}

/** Clone déterministe du substrat : mêmes fréquences propres (graine 42). */
function clonerSubstrat(): MoteurCpu {
  return new MoteurCpu({ ...CONFIG_FUSION });
}

/** Énergie moyenne du champ (moyenne des amplitudes absolues) — sync. */
function energieChamp(moteur: MoteurCpu): number {
  const amplitudes = moteur.amplitudes();
  let somme = 0;
  for (let i = 0; i < amplitudes.length; i++) somme += Math.abs(amplitudes[i]);
  return somme / amplitudes.length;
}

export class NoeudOndesUnifie {
  private readonly moteur: MoteurCpu;
  private traces: TraceOnde[] = [];
  private compteurId = 0;

  constructor(private readonly cleUtilisateur: string) {
    this.moteur = new MoteurCpu({ ...CONFIG_FUSION });
  }

  get cle(): string {
    return this.cleUtilisateur;
  }

  /** Journal d'ondes vivant (la mémoire du champ). */
  get tailleMemoire(): number {
    return this.traces.length;
  }

  /**
   * ÉCRITURE DE MÉMOIRE — les données de l'utilisateur deviennent des
   * ondes commises dans le champ : chaque échange vécu enrichit le
   * substrat que les requêtes suivantes vont résonner.
   */
  memoriser(entree: { modalite: Modalite; concepts: string[]; texte: string }, options: OptionsUtilisateur = {}): ResultatMemorisation {
    void options; // l'isolement est assuré par un champ par utilisateur
    const impulsions = encoderEntreeMultimodale({ modalite: entree.modalite, concepts: entree.concepts }, CONFIG_FUSION.largeur, CONFIG_FUSION.hauteur);
    if (impulsions.length === 0) {
      return { traceId: "", impulsions: 0, concepts: [], pasTotaux: this.moteur.pasTotaux };
    }
    this.moteur.injecter(impulsions);
    for (let i = 0; i < PAS_GRAVURE; i++) this.moteur.avancer(); // gravure
    const traceId = `onde_${this.cleUtilisateur.slice(0, 8)}_${++this.compteurId}`;
    const trace: TraceOnde = {
      id: traceId,
      impulsions,
      texte: entree.texte.slice(0, 400),
      modalite: entree.modalite,
      horodatage: Date.now(),
      concepts: entree.concepts.map(canonicaliserConcept).filter(Boolean).slice(0, 12),
    };
    this.traces.push(trace);
    if (this.traces.length > MAX_TRACES) this.traces.shift(); // éviction ancienne
    return { traceId, impulsions: impulsions.length, concepts: trace.concepts, pasTotaux: this.moteur.pasTotaux };
  }

  /**
   * LECTURE PAR IMPULSIONS DIRECTES (SSL, distillation, raisonnement) :
   * même mécanisme que comprendre() — injection, propagation, attention
   * spike-driven sur les souvenirs commis.
   */
  async comprendreImpulsions(impulsionsRequete: Impulsion[]): Promise<ComprehensionOndes> {
    if (impulsionsRequete.length > 0) this.moteur.injecter(impulsionsRequete);
    this.moteur.avancer();
    const lecture = await this.moteur.lire();
    const candidats = this.traces.slice(-MAX_CANDIDATS);
    if (candidats.length === 0 || impulsionsRequete.length === 0) {
      return { resonances: [], souvenirDominant: null, ordreR: lecture.ordreR, energie: lecture.energie, tailleMemoire: this.traces.length };
    }
    const pic = lecture.pics.reduce<Pic | null>((meilleur, p) => (meilleur === null || p.amplitude > meilleur.amplitude ? p : meilleur), null);
    const resultat = attentionSpikeDriven(candidats, (trace) => this.mesurerTrace(trace, impulsionsRequete, pic), lecture.energie);
    const resonances: ResonanceMemoire[] = resultat.poids
      .map((p: PoidsAttention) => {
        const trace = candidats.find((t) => t.id === p.traceId)!;
        return { traceId: p.traceId, poids: p.poids, gain: p.gainResonance, latencePic: p.latencePic, extrait: trace.texte.slice(0, 120) };
      })
      .filter((r) => r.gain > 0)
      .sort((a, b) => b.poids - a.poids);
    const dominante = resonances.length > 0 && resonances[0].poids >= SEUIL_DOMINANT ? resonances[0] : null;
    return { resonances, souvenirDominant: dominante, ordreR: lecture.ordreR, energie: lecture.energie, tailleMemoire: this.traces.length };
  }

  /**
   * Écriture conversationnelle — chemin réel du moteur Gen3 : l'échange
   * utilisateur+réponse est mémorisé comme ondes (modalité texte).
   */
  memoriserEchange(prompt: string, reponse: string, options: OptionsUtilisateur = {}): ResultatMemorisation {
    const concepts = extraireConcepts(`${prompt} ${reponse}`);
    return this.memoriser({ modalite: "texte", concepts, texte: `Q: ${prompt} R: ${reponse}` }, options);
  }

  /**
   * LECTURE DE MÉMOIRE = CALCUL NEURONAL — la requête est injectée dans le
   * champ vivant ; chaque souvenir candidat est RÉINJECTÉ dans un clone du
   * même substrat ; l'attention spike-driven pèse les résonances.
   */
  async comprendre(prompt: string, options: OptionsUtilisateur = {}): Promise<ComprehensionOndes> {
    void options;
    const impulsionsRequete = encoderEntreeMultimodale({ modalite: "texte", concepts: extraireConcepts(prompt) }, CONFIG_FUSION.largeur, CONFIG_FUSION.hauteur);
    if (impulsionsRequete.length > 0) this.moteur.injecter(impulsionsRequete);
    this.moteur.avancer();
    const lecture = await this.moteur.lire();
    const energieRequete = lecture.energie;

    const candidats = this.traces.slice(-MAX_CANDIDATS);
    if (candidats.length === 0 || impulsionsRequete.length === 0) {
      return { resonances: [], souvenirDominant: null, ordreR: lecture.ordreR, energie: lecture.energie, tailleMemoire: this.traces.length };
    }

    const pic = lecture.pics.reduce<Pic | null>((meilleur, p) => (meilleur === null || p.amplitude > meilleur.amplitude ? p : meilleur), null);

    const resultat = attentionSpikeDriven(candidats, (trace) => this.mesurerTrace(trace, impulsionsRequete, pic), energieRequete);

    const resonances: ResonanceMemoire[] = resultat.poids
      .map((p: PoidsAttention) => {
        const trace = candidats.find((t) => t.id === p.traceId)!;
        return { traceId: p.traceId, poids: p.poids, gain: p.gainResonance, latencePic: p.latencePic, extrait: trace.texte.slice(0, 120) };
      })
      .filter((r) => r.gain > 0)
      .sort((a, b) => b.poids - a.poids);

    const dominante = resonances.length > 0 && resonances[0].poids >= SEUIL_DOMINANT ? resonances[0] : null;
    return { resonances, souvenirDominant: dominante, ordreR: lecture.ordreR, energie: lecture.energie, tailleMemoire: this.traces.length };
  }

  /**
   * Mesure d'une trace : clone du substrat → requête seule (pic de base)
   * → souvenir réinjecté → gains RELATIFS pas à pas + alignement de phase
   * entre souvenir et pic de la requête (cohérence de Kuramoto locale).
   */
  private mesurerTrace(trace: TraceOnde, impulsionsRequete: Impulsion[], pic: Pic | null): { gainsParPas: number[]; alignementPhase: number } {
    void pic;
    const clone = this.clonerPourMesure();
    clone.injecter(impulsionsRequete);
    for (let i = 0; i < PAS_MESURE; i++) clone.avancer();
    const energieBase = energieChamp(clone);
    // Cellules PARTAGÉES requête ↔ souvenir : les récepteurs communs (même
    // position dans la grille) — c'est là que la cohérence de phase a du sens.
    const cellulesRequete = new Set(impulsionsRequete.map((i) => Math.floor(i.y) * CONFIG_FUSION.largeur + Math.floor(i.x)));
    const phasesAvant = clone.phases();
    const partages = trace.impulsions
      .map((i) => Math.floor(i.y) * CONFIG_FUSION.largeur + Math.floor(i.x))
      .filter((indice) => cellulesRequete.has(indice));
    const phasesApresAvant = partages.map((indice) => phasesAvant[indice]);

    clone.injecter(trace.impulsions);
    const gainsParPas: number[] = [];
    for (let i = 0; i < PAS_MESURE; i++) {
      clone.avancer();
      gainsParPas.push(Math.max(0, energieChamp(clone) - energieBase));
    }
    // Alignement de phase aux RÉCEPTEURS PARTAGÉS : cos(θ_après − θ_avant)
    // — un souvenir qui réinjecte là où la requête résonne s'y met EN PHASE
    // (cohérence de Kuramoto locale, ∈ [0, 1]) ; sans récepteur partagé,
    // la trace est légèrement pénalisée (0.45 < 0.5 neutre).
    let alignement = 0.45;
    if (partages.length > 0) {
      const phasesApres = clone.phases();
      const coherences = partages.map((indice, k) => (Math.cos(phasesApres[indice] - phasesApresAvant[k]) + 1) / 2);
      alignement = coherences.reduce((a, b) => a + b, 0) / coherences.length;
    }
    return { gainsParPas, alignementPhase: alignement };
  }

  /** Lecture PROPRE de l'état du champ (télémétrie matérielle — aucune injection). */
  async etatChamp(): Promise<{ energie: number; ordreR: number; nbPics: number }> {
    const lecture = await this.moteur.lire();
    return { energie: lecture.energie, ordreR: lecture.ordreR, nbPics: lecture.pics.length };
  }

  /**
   * Clone du substrat pour les mesures — HÉRITE de la carte de fréquences
   * courante (l'état appris par la plasticité hébbienne est présent dans
   * chaque mesure : le champ mesuré est le champ vivant).
   */
  clonerPourMesure(): MoteurCpu {
    const clone = clonerSubstrat();
    clone.remplacerFrequences(this.moteur.frequences());
    return clone;
  }

  /**
   * RENFORCEMENT HÉBBIEN RÉEL — writeback de la carte de fréquences propres
   * : aux cellules des concepts renforcés, la fréquence propre est portée
   * vers la borne haute (bornes BORNES_PHYSIQUES) dans un rayon gaussien —
   * le champ apprend à faire résonner ces concepts plus vite et plus fort
   * (plasticité structurelle du substrat, pas une table de méta-données).
   */
  renforcerConcepts(concepts: string[], facteur = 0.35): void {
    const frequences = this.moteur.frequences();
    const { largeur: w, hauteur: h } = CONFIG_FUSION;
    const carte = frequences.slice();
    for (const concept of concepts) {
      const canonical = canonicaliserConcept(concept);
      if (!canonical) continue;
      const hash = hacherConcept(canonical);
      const { x, y } = positionDepuisHachage(hash, w, h);
      const rayon = 2.5;
      for (let dy = -Math.ceil(rayon); dy <= Math.ceil(rayon); dy++) {
        for (let dx = -Math.ceil(rayon); dx <= Math.ceil(rayon); dx++) {
          const cx = Math.floor(x) + dx;
          const cy = Math.floor(y) + dy;
          if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance > rayon) continue;
          const indice = cy * w + cx;
          // RÈGLE LOCALE (type STDP/Hebb) : tirer la fréquence propre vers la
          // MOYENNE DES VOISINS 4-connexes — l'alignement des ω accélère la
          // synchronisation de Kuramoto (r ↑) → le couplage comble mieux les
          // ondes masquées lors de la reconstruction (erreur ↓).
          const voisins: number[] = [];
          if (cx > 0) voisins.push(carte[indice - 1]);
          if (cx < w - 1) voisins.push(carte[indice + 1]);
          if (cy > 0) voisins.push(carte[indice - w]);
          if (cy < h - 1) voisins.push(carte[indice + w]);
          if (voisins.length === 0) continue;
          const moyenne = voisins.reduce((a, b) => a + b, 0) / voisins.length;
          // Alignement voisin + accord vers la fréquence PROPRE du concept
          // (le champ apprend la tonalité attendue au récepteur manquant).
          const signature = projeterConcept(canonical, w, h);
          const freqConcept = signature.impulsions[0]?.frequence ?? moyenne;
          const cibleLocale = 0.5 * moyenne + 0.5 * freqConcept;
          frequences[indice] = Math.min(FREQUENCE_MAX, Math.max(FREQUENCE_MIN, carte[indice] + facteur * (cibleLocale - carte[indice])));
        }
      }
    }
    this.moteur.remplacerFrequences(frequences);
  }

  /** Impulsions d'un concept isolé (distillation, chaîne de raisonnement). */
  impulsionsConcept(concept: string): Impulsion[] {
    return projeterConcept(concept, CONFIG_FUSION.largeur, CONFIG_FUSION.hauteur).impulsions;
  }

  /** Souvenir par id (chaîne de raisonnement, tests). */
  traceParId(id: string): TraceOnde | undefined {
    return this.traces.find((t) => t.id === id);
  }

  /** Derniers souvenirs (évaluation matérielle, télémétrie). */
  dernieresTraces(n: number): TraceOnde[] {
    return this.traces.slice(-n);
  }
}
