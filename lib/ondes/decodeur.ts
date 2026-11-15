/**
 * Décodeur de résonance — reconvertit les pics d'ondes stabilisés en mots.
 *
 * Un pic de résonance n'est « lisible » que s'il persiste : le décodeur
 * suit chaque pic au fil des readbacks (pistes), mesure sa stabilité,
 * et lorsqu'une piste devient un attracteur stable (stabilité ≥ seuil,
 * amplitude ≥ plancher), la carte inverse (`CarteInverse`) reconvertit
 * sa position en mot. Les mots sont émis PROGRESSIVEMENT — cadencés —
 * c'est ce flux qui alimente l'écriture mot-à-mot des réponses de l'IA.
 *
 * Garde-fous cognitifs : anti-répétition (fenêtre glissante), anti-
 * rafale (intervalle minimum entre deux émissions), amnésie douce des
 * pistes perdues.
 */

import type { CarteInverse } from "./encodeur";
import type { Pic } from "./types";

export interface OptionsDecodeur {
  /** Stabilité (readbacks consécutifs) requise pour qu'un pic « parle ». */
  stabiliteRequise: number;
  /** Amplitude minimale d'un pic lisible. */
  amplitudeMin: number;
  /** Distance maximale (cellules) entre deux observations du même pic. */
  rayonFusion: number;
  /** Intervalle minimum (ms) entre deux émissions de mots. */
  intervalleMinMs: number;
  /** Taille de la fenêtre anti-répétition. */
  fenetreAntirepetition: number;
}

export const OPTIONS_DEFAUT: OptionsDecodeur = {
  stabiliteRequise: 3,
  amplitudeMin: 0.8,
  rayonFusion: 6,
  intervalleMinMs: 90,
  fenetreAntirepetition: 8,
};

interface Piste {
  x: number;
  y: number;
  stabilite: number;
  absences: number;
  amplitudeMax: number;
  phase: number;
}

export class DecodeurResonance {
  private readonly options: OptionsDecodeur;
  private pistes: Piste[] = [];
  private derniersMots: string[] = [];
  private dernierEmissionMs = 0;
  private dernierMot = "";

  constructor(
    private readonly carte: CarteInverse,
    private dim: number,
    options?: Partial<OptionsDecodeur>,
  ) {
    this.options = { ...OPTIONS_DEFAUT, ...options };
  }

  /** Nombre de pistes suivies (diagnostique). */
  get nbPistes(): number {
    return this.pistes.length;
  }

  /** Dimension de grille courante (mise à jour au changement d'effort). */
  redimensionner(dim: number): void {
    this.dim = dim;
    this.pistes = [];
  }

  /**
   * Observe les pics du readback courant et retourne les mots prêts à
   * être émis (0 ou 1 mot par appel — l'écriture reste progressive).
   *
   * @param pics pics détectés par le moteur (déjà triés par amplitude)
   * @param maintenant horloge du client (performance.now())
   */
  observer(pics: Pic[], maintenant: number): string | null {
    this.suivrePistes(pics);

    // Choisit la piste la plus stable parmi celles qui viennent d'atteindre
    // le seuil (récemment stabilisées), en privilégiant l'amplitude.
    let candidate: Piste | null = null;
    for (const piste of this.pistes) {
      if (piste.stabilite < this.options.stabiliteRequise) continue;
      if (piste.amplitudeMax < this.options.amplitudeMin) continue;
      if (candidate === null || piste.stabilite > candidate.stabilite) {
        candidate = piste;
      }
    }
    if (candidate === null) return null;
    if (maintenant - this.dernierEmissionMs < this.options.intervalleMinMs) return null;

    const mot = this.carte.motLePlusProche(candidate.x, candidate.y, this.dim);
    if (mot === null) return null;

    // Anti-répétition : pas deux fois le même mot de suite, et pas de
    // retour en boucle courte (fenêtre glissante).
    if (mot === this.dernierMot) return null;
    if (this.derniersMots.slice(-this.options.fenetreAntirepetition).includes(mot)) {
      // Le pic existe mais sa parole tourne en boucle : on consomme la
      // piste (elle re-stabilisera ailleurs) sans émettre.
      candidate.stabilite = 0;
      return null;
    }

    candidate.stabilite = 0; // le mot est prononcé, la piste repart
    this.dernierEmissionMs = maintenant;
    this.dernierMot = mot;
    this.derniersMots.push(mot);
    if (this.derniersMots.length > this.options.fenetreAntirepetition * 2) {
      this.derniersMots.shift();
    }
    return mot;
  }

  /** Apparie les pics observés aux pistes existantes (plus proche voisin). */
  private suivrePistes(pics: Pic[]): void {
    const rayon = this.options.rayonFusion;
    const utilisees = new Set<number>();

    for (const piste of this.pistes) {
      let meilleurIndex = -1;
      let meilleureD2 = rayon * rayon + 1;
      for (let i = 0; i < pics.length; i++) {
        if (utilisees.has(i)) continue;
        const pic = pics[i];
        const dx = pic.x - piste.x;
        const dy = pic.y - piste.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < meilleureD2) {
          meilleureD2 = d2;
          meilleurIndex = i;
        }
      }
      if (meilleurIndex >= 0) {
        const pic = pics[meilleurIndex];
        utilisees.add(meilleurIndex);
        // Moyenne mobile douce de la position (suivi fluide).
        piste.x = piste.x * 0.7 + pic.x * 0.3;
        piste.y = piste.y * 0.7 + pic.y * 0.3;
        piste.stabilite++;
        piste.absences = 0;
        piste.amplitudeMax = Math.max(piste.amplitudeMax * 0.98, pic.amplitude);
        piste.phase = pic.phase;
      } else {
        piste.absences++;
        // Amnésie douce : une piste disparaît après quelques absences.
        if (piste.absences > 3) piste.stabilite = Math.max(0, piste.stabilite - 2);
      }
    }

    // Nouvelles pistes pour les pics non appariés.
    for (let i = 0; i < pics.length; i++) {
      if (utilisees.has(i)) continue;
      const pic = pics[i];
      this.pistes.push({
        x: pic.x,
        y: pic.y,
        stabilite: 1,
        absences: 0,
        amplitudeMax: pic.amplitude,
        phase: pic.phase,
      });
    }

    // Élagage : maximum 32 pistes (les plus stables d'abord).
    if (this.pistes.length > 32) {
      this.pistes.sort((a, b) => b.stabilite - a.stabilite);
      this.pistes.length = 32;
    }
  }

  /** Réinitialise le suivi (nouveau tour de conversation). */
  reinitialiser(): void {
    this.pistes = [];
    this.derniersMots = [];
    this.dernierMot = "";
    this.dernierEmissionMs = 0;
  }
}
