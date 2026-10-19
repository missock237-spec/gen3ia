/**
 * Champ d'ondes neuronales — implémentation CPU de référence.
 *
 * Chaque cellule de la grille est un oscillateur (phase θ, amplitude A,
 * fréquence propre ω). La dynamique combine :
 *
 *  1. Propagation d'onde discrète (équation de d'Alembert discrétisée) :
 *       A[t+1] = (2·A[t] − A[t−1] + c²·∇²A[t]) · amortissement
 *  2. Couplage de phase de Kuramoto sur le voisinage 4-connexe :
 *       θᵢ[t+1] = θᵢ + ωᵢ·dt + K·dt·Σ_voisins sin(θⱼ − θᵢ)
 *  3. Gain cohérent : les zones synchronisées (Σsin > 0) amplifient
 *     l'onde — la « pensée » émerge de la synchronisation.
 *
 * C'est l'implémentation MIRROIR du compute shader WGSL
 * (`shader.ts`) : mêmes formules, mêmes ordres de grandeur — elle sert
 * de repli universel (navigateurs sans WebGPU) et de spécification
 * exécutable testée unitairement.
 */

import { BORNES_PHYSIQUES, type ConfigOndes, type Impulsion, type PaquetOnde, type Pic } from "./types";

export interface LectureChamp {
  pics: Pic[];
  /** Paramètre d'ordre de Kuramoto r ∈ [0, 1]. */
  ordreR: number;
  /** Énergie moyenne (moyenne des amplitudes absolues). */
  energie: number;
}

/**
 * Interface commune des moteurs (WebGPU et CPU) — le laboratoire
 * d'ondes pilote l'un ou l'autre sans connaître leur implémentation.
 */
export interface MoteurOndes {
  readonly type: "webgpu" | "cpu";
  readonly largeur: number;
  readonly hauteur: number;
  /** Met en file des impulsions à injecter au prochain pas (max 16/pas). */
  injecter(impulsions: Impulsion[]): void;
  /** Injecte un micro-paquet reçu de l'essaim P2P (atténuation du saut). */
  injecterPaquet(paquet: PaquetOnde): void;
  /** Nombre total de pas de simulation exécutés depuis l'initialisation. */
  readonly pasTotaux: number;
  /** Avance `pasParImage` pas de simulation. */
  avancer(): void;
  /** Lit l'état courant (pics de résonance, ordre, énergie) — async côté GPU. */
  lire(): Promise<LectureChamp>;
  /** Rendu : amplitudes courantes (longueur largeur·hauteur). */
  amplitudes(): Float32Array;
  /** Rendu : phases courantes (longueur largeur·hauteur). */
  phases(): Float32Array;
  /** Carte des fréquences propres (support de l'évolution hebbienne). */
  frequences(): Float32Array;
  /** Applique une carte de fréquences évoluée (writeback). */
  remplacerFrequences(frequences: Float32Array): void;
  /** Configuration physique courante. */
  config(): ConfigOndes;
  /** Change de configuration (effort) : reconstruit si dimensions changent. */
  reconfigurer(config: ConfigOndes): void;
  /** Libère les ressources GPU éventuelles. */
  detruire(): void;
}

/** File d'impulsions maximale par pas — limite le buffer uniform GPU. */
export const MAX_IMPULSIONS_PAR_PAS = 16;

export class MoteurCpu implements MoteurOndes {
  readonly type = "cpu" as const;

  private cfg: ConfigOndes;
  private ampActuel: Float32Array;
  private ampPasse: Float32Array;
  private ampSuivant: Float32Array;
  private phase: Float32Array;
  private freq: Float32Array;
  private fileImpulsions: Impulsion[] = [];
  private compteurPas = 0;

  /** Nombre total de pas exécutés (métrique temps réel). */
  get pasTotaux(): number {
    return this.compteurPas;
  }

  constructor(cfg: ConfigOndes) {
    this.cfg = cfg;
    const n = cfg.largeur * cfg.hauteur;
    this.ampActuel = new Float32Array(n);
    this.ampPasse = new Float32Array(n);
    this.ampSuivant = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.freq = new Float32Array(n);
    this.initialiserFrequences();
  }

  /** Fréquences propres initiales : bruit lent déterministe (graine 42). */
  private initialiserFrequences(): void {
    const { largeur: w, hauteur: h } = this.cfg;
    let graine = 42;
    const alea = () => {
      // LCG déterministe — même carte de fréquences à chaque initialisation.
      graine = (graine * 1664525 + 1013904223) >>> 0;
      return graine / 0xffffffff;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        this.freq[i] =
          BORNES_PHYSIQUES.frequenceMin +
          alea() * (BORNES_PHYSIQUES.frequenceMax - BORNES_PHYSIQUES.frequenceMin);
      }
    }
  }

  get largeur(): number {
    return this.cfg.largeur;
  }

  get hauteur(): number {
    return this.cfg.hauteur;
  }

  injecter(impulsions: Impulsion[]): void {
    for (const imp of impulsions) {
      if (this.fileImpulsions.length >= MAX_IMPULSIONS_PAR_PAS * 8) break;
      this.fileImpulsions.push(imp);
    }
  }

  injecterPaquet(paquet: PaquetOnde): void {
    // Atténuation du saut réseau : chaque saut P2P affaiblit l'onde
    // (comme une perte d'énergie de propagation), le TTL borne la boucle.
    const attenuation = 0.82;
    this.injecter([
      {
        x: paquet.p[0],
        y: paquet.p[1],
        amplitude: Math.min(5, paquet.a * attenuation),
        frequence: paquet.f,
        phase: paquet.th,
        rayon: 2.2,
      },
    ]);
  }

  avancer(): void {
    const pas = Math.max(1, this.cfg.pasParImage);
    for (let k = 0; k < pas; k++) this.unPas();
  }

  /** Un pas de simulation — MIRROIR exact du shader WGSL. */
  private unPas(): void {
    const { largeur: w, hauteur: h, c2, amortissement, couplage, dt, gain } = this.cfg;
    const { ampActuel: cur, ampPasse: past, ampSuivant: next, phase: ph, freq: fr } = this;

    // 1) Injections de ce pas (gaussiennes, max 16 comme côté GPU).
    const lot = this.fileImpulsions.splice(0, MAX_IMPULSIONS_PAR_PAS);
    const rayon = 2.5;
    for (const imp of lot) {
      const x0 = Math.max(1, Math.floor(imp.x - rayon));
      const x1 = Math.min(w - 2, Math.ceil(imp.x + rayon));
      const y0 = Math.max(1, Math.floor(imp.y - rayon));
      const y1 = Math.min(h - 2, Math.ceil(imp.y + rayon));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - imp.x;
          const dy = y - imp.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < rayon * rayon) {
            const i = y * w + x;
            cur[i] += imp.amplitude * Math.exp(-d2 / 1.4);
            ph[i] += 0.5 * Math.sin(imp.frequence * this.compteurPas - ph[i]);
          }
        }
      }
    }

    // 2) Propagation + Kuramoto + gain cohérent (bords absorbants).
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const centre = cur[i];
        const propagation = cur[i - 1] + cur[i + 1] + cur[i - w] + cur[i + w] - 4 * centre;
        let valeur = (2 * centre - past[i] + c2 * propagation) * amortissement;

        const p = ph[i];
        const sync =
          Math.sin(ph[i - 1] - p) +
          Math.sin(ph[i + 1] - p) +
          Math.sin(ph[i - w] - p) +
          Math.sin(ph[i + w] - p);
        ph[i] = p + fr[i] * dt + couplage * dt * sync;

        // Gain cohérent : la synchronisation locale amplifie l'onde.
        valeur += gain * (sync * 0.25) * centre;

        next[i] = valeur;
      }
    }

    // 3) Bords absorbants (amplitude nulle, phase continue).
    for (let x = 0; x < w; x++) {
      next[x] = 0;
      next[(h - 1) * w + x] = 0;
    }
    for (let y = 0; y < h; y++) {
      next[y * w] = 0;
      next[y * w + w - 1] = 0;
    }

    // 4) Rotation des tampons (cur ← next).
    const tmp = past;
    this.ampPasse = cur;
    this.ampActuel = next;
    this.ampSuivant = tmp;

    this.compteurPas++;
  }

  async lire(): Promise<LectureChamp> {
    return this.lireSync();
  }

  /** Lecture synchrone (le CPU n'a pas de barrière de copie). */
  private lireSync(): LectureChamp {
    const { largeur: w, hauteur: h } = this.cfg;
    const pics: Pic[] = [];
    const seuil = 0.35;
    let sommeCos = 0;
    let sommeSin = 0;
    let energieSomme = 0;
    let echantillons = 0;

    for (let y = 2; y < h - 2; y += 2) {
      for (let x = 2; x < w - 2; x += 2) {
        const i = y * w + x;
        const a = Math.abs(this.ampActuel[i]);
        energieSomme += a;
        sommeCos += Math.cos(this.phase[i]);
        sommeSin += Math.sin(this.phase[i]);
        echantillons++;
        if (a < seuil) continue;
        // Maximum local 4-connexe (échantillonnage pair).
        if (
          a >= Math.abs(this.ampActuel[i - 1]) &&
          a >= Math.abs(this.ampActuel[i + 1]) &&
          a >= Math.abs(this.ampActuel[i - w]) &&
          a > Math.abs(this.ampActuel[i + w])
        ) {
          pics.push({ x, y, amplitude: a, phase: this.phase[i] });
        }
      }
    }

    pics.sort((p1, p2) => p2.amplitude - p1.amplitude);
    const ordreR = echantillons > 0 ? Math.hypot(sommeCos, sommeSin) / echantillons : 0;
    const energie = echantillons > 0 ? energieSomme / echantillons : 0;
    return { pics: pics.slice(0, 12), ordreR, energie };
  }

  amplitudes(): Float32Array {
    return this.ampActuel;
  }

  phases(): Float32Array {
    return this.phase;
  }

  frequences(): Float32Array {
    return this.freq;
  }

  remplacerFrequences(frequences: Float32Array): void {
    if (frequences.length === this.freq.length) this.freq.set(frequences);
  }

  config(): ConfigOndes {
    return this.cfg;
  }

  reconfigurer(cfg: ConfigOndes): void {
    const memeGrille = cfg.largeur === this.cfg.largeur && cfg.hauteur === this.cfg.hauteur;
    const anciennesFreq = this.freq;
    this.cfg = cfg;
    if (!memeGrille) {
      const n = cfg.largeur * cfg.hauteur;
      this.ampActuel = new Float32Array(n);
      this.ampPasse = new Float32Array(n);
      this.ampSuivant = new Float32Array(n);
      this.phase = new Float32Array(n);
      this.freq = new Float32Array(n);
      this.initialiserFrequences();
      this.fileImpulsions = [];
      this.compteurPas = 0;
    } else {
      this.freq = anciennesFreq;
    }
  }

  detruire(): void {
    // Rien à libérer côté CPU (GC) — présent pour l'homogénéité.
    this.fileImpulsions = [];
  }
}
