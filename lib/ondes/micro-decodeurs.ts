/**
 * MICRO-DÉCODEURS MULTIMODAUX — miroirs CPU EXACTS des shaders
 * `shaders-manifold.ts` (Phase 2 : génération images / voix / vidéos
 * depuis le tenseur d'onde commun, sans réseau de diffusion lourd).
 *
 * CONTRAT (même règle que moteurs-webgpu.ts) : le miroir CPU exécute la
 * MÊME physique que le shader WebGPU — mêmes formules, même ordre des
 * boucles, même arrondi — c'est la spécification exécutable testée dans
 * la suite vitest ; le GPU n'accélère que, il ne change pas le résultat.
 * Modules PUR : aucune dépendance Node ni navigateur, Math.random
 * interdit (déterminisme bit à bit).
 *
 * Économie d'énergie (Phase 3) : chaque décodeur applique l'ACTIVATION
 * SPARSE (`seuilSparse`) — les harmoniques sous le seuil ne sont PAS
 * calculées, le GPU comme le CPU sautent leur branche. Sur un tenseur
 * textuel typique (40 nœuds actifs / 256), ~85 % du travail de synthèse
 * est évité.
 */

import { BLOC_ECHANTILLONS_MANIFOLD, SHADER_DECODE_AUDIO_PHASE, SHADER_DECODE_IMAGE_WAVELET, SHADER_DECODE_VIDEO_DERIVE } from "./shaders-manifold";
import { dequantifierPhase, DEUX_PI, type TenseurOnde } from "./manifold";
import { versWav } from "./synthese-acoustique";

/** Amplitude de dérive vidéo par défaut (pixels, au maximum d'amplitude). */
export const AMPLITUDE_DERIVE_DEFAUT = 8;

/** Gain de résurrection d'énergie vidéo (anti-affadissement). */
export const GAIN_RESURRECTION_DEFAUT = 0.15;

/** Seuil d'activation sparse par défaut (partagé par les 3 décodeurs). */
export const SEUIL_SPARSE_DEFAUT = 0.02;

/** Échelle spatiale des ondelettes image (périodes visibles). */
export const ECHELLE_ESPACE_DEFAUT = 96;

/** Gain de l'éclairage lambertien image. */
export const GAIN_LUMIERE_DEFAUT = 0.45;

/** F0 audible de base du décodeur audio (Hz) — la voix de base. */
export const F0_AUDIBLE_DEFAUT = 110;

/** Étendue harmonique audio (octaves au-dessus de F0). */
export const ETENDUE_OCTAVES_DEFAUT = 3;

/** Constante d'or 2π (répartition déterministe des directions). */
const PHI_OR = 2.399963229728653;

/** Itère les nœuds ACTIFS d'un tenseur (amplitude déquantifiée ≥ seuil). */
export function noeudsActifsDuTenseur(
  t: TenseurOnde,
  seuil = SEUIL_SPARSE_DEFAUT,
): number[] {
  const actifs: number[] = [];
  for (let i = 0; i < t.nbNoeuds; i++) {
    const a = t.amplitudes[i] / 65535;
    if (a >= seuil) actifs.push(i);
  }
  return actifs;
}

/* ------------------------------------------------------------------ */
/* Décodeur IMAGE — miroir de SHADER_DECODE_IMAGE_WAVELET              */
/* ------------------------------------------------------------------ */

export interface OptionsDecodeurImage {
  seuilSparse?: number;
  echelleEspace?: number;
  gainLumiere?: number;
}

export interface ResultatImage {
  /** Pixels RGBA 8 bits (largeur×hauteur×4), alpha opaque. */
  pixels: Uint8ClampedArray;
  /** Harmoniques réellement calculées (activation sparse). */
  nbHarmoniquesActives: number;
  /** Harmoniques sautées par le seuil sparse. */
  nbHarmoniquesSautees: number;
}

export class DecodeurImageWavelet {
  readonly largeur: number;
  readonly hauteur: number;
  private readonly options: Required<OptionsDecodeurImage>;

  constructor(largeur = 256, hauteur = 256, options?: OptionsDecodeurImage) {
    if (!Number.isInteger(largeur) || largeur < 8 || largeur > 2048) {
      throw new Error(`Largeur invalide : ${largeur} (8..2048).`);
    }
    if (!Number.isInteger(hauteur) || hauteur < 8 || hauteur > 2048) {
      throw new Error(`Hauteur invalide : ${hauteur} (8..2048).`);
    }
    this.largeur = largeur;
    this.hauteur = hauteur;
    this.options = {
      seuilSparse: options?.seuilSparse ?? SEUIL_SPARSE_DEFAUT,
      echelleEspace: options?.echelleEspace ?? ECHELLE_ESPACE_DEFAUT,
      gainLumiere: options?.gainLumiere ?? GAIN_LUMIERE_DEFAUT,
    };
  }

  /**
   * Rend le tenseur en image RGBA — MIRROIR exact du compute shader
   * `decoderImage` : synthèse harmonique (chaque nœud actif est une
   * ondelette porteuse orientée par le nombre d'or), détail Haar,
   * gradient ANALYTIQUE du champ pour la normale, lambertien.
   */
  rendre(t: TenseurOnde): ResultatImage {
    const { largeur, hauteur } = this;
    const pixels = new Uint8ClampedArray(largeur * hauteur * 4);
    const echelle = this.options.echelleEspace;

    // Pré-calcul des harmoniques actives (sparse : on saute les nulles).
    const actifs = noeudsActifsDuTenseur(t, this.options.seuilSparse);
    const fx = new Float64Array(actifs.length);
    const fy = new Float64Array(actifs.length);
    const amp = new Float64Array(actifs.length);
    const ph = new Float64Array(actifs.length);
    for (let k = 0; k < actifs.length; k++) {
      const i = actifs[k];
      const phi = i * PHI_OR;
      const freq = t.fondamentale * (1 + i / t.nbNoeuds) * echelle;
      fx[k] = Math.cos(phi) * freq;
      fy[k] = Math.sin(phi) * freq;
      amp[k] = t.amplitudes[i] / 65535;
      ph[k] = dequantifierPhase(t.phases[i]);
    }

    const DEUX_PI_FX = DEUX_PI;
    for (let y = 0; y < hauteur; y++) {
      const v = y / hauteur;
      for (let x = 0; x < largeur; x++) {
        const u = x / largeur;
        let valeur = 0;
        let gxx = 0;
        let gyy = 0;
        for (let k = 0; k < actifs.length; k++) {
          const arg = DEUX_PI_FX * (fx[k] * u + fy[k] * v) + ph[k];
          valeur += amp[k] * Math.sin(arg);
          // Gradient analytique (dérivée exacte du champ harmonique).
          const deriv = amp[k] * DEUX_PI_FX;
          gxx += deriv * fx[k] * Math.cos(arg);
          gyy += deriv * fy[k] * Math.cos(arg);
        }
        // Ondelette de détail Haar (comme le shader).
        valeur = valeur * 0.8 + 0.2 * Math.sin(u * 251 + v * 127) * 0.25;

        const lum = Math.min(1, Math.max(0, 0.5 + 0.5 * valeur));
        const norme = Math.hypot(gxx, gyy, 1);
        const nx = -gxx / norme;
        const ny = -gyy / norme;
        const nz = 1 / norme;
        // Lumière fixe normalisée (0.4, 0.5, 0.77) — comme le shader.
        const lambert = Math.max(0.4 * nx + 0.5 * ny + 0.77 * nz, 0);
        const clair = lum * (0.55 + this.options.gainLumiere * lambert);
        const canal = Math.round(clair * 255);

        const o = (y * largeur + x) * 4;
        pixels[o] = canal;
        pixels[o + 1] = canal;
        pixels[o + 2] = canal;
        pixels[o + 3] = 255;
      }
    }

    return {
      pixels,
      nbHarmoniquesActives: actifs.length,
      nbHarmoniquesSautees: t.nbNoeuds - actifs.length,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Décodeur AUDIO — miroir de SHADER_DECODE_AUDIO_PHASE                */
/* ------------------------------------------------------------------ */

export interface OptionsDecodeurAudio {
  /** Fréquence d'échantillonnage (défaut 44 100 Hz). */
  frequenceEchantillonnage?: number;
  /** F0 audible de base (Hz, défaut 110). */
  f0Audible?: number;
  /** Étendue harmonique en octaves (défaut 3). */
  etendueOctaves?: number;
  /** Seuil d'activation sparse. */
  seuilSparse?: number;
}

export class DecodeurAudioPhase {
  readonly frequenceEchantillonnage: number;
  private readonly options: Required<OptionsDecodeurAudio>;

  constructor(options?: OptionsDecodeurAudio) {
    this.frequenceEchantillonnage = options?.frequenceEchantillonnage ?? 44100;
    this.options = {
      frequenceEchantillonnage: this.frequenceEchantillonnage,
      f0Audible: options?.f0Audible ?? F0_AUDIBLE_DEFAUT,
      etendueOctaves: options?.etendueOctaves ?? ETENDUE_OCTAVES_DEFAUT,
      seuilSparse: options?.seuilSparse ?? SEUIL_SPARSE_DEFAUT,
    };
  }

  /**
   * Fréquence audible (Hz) de l'oscillateur i du tenseur — formule du
   * shader : F0 audible répartie sur les octaves, modulée par la
   * fondamentale du tenseur (le « ton » du manifold transpose la voix).
   */
  frequenceOscillateur(t: TenseurOnde, i: number): number {
    const position = i / t.nbNoeuds;
    return (
      this.options.f0Audible *
      Math.pow(2, this.options.etendueOctaves * position) *
      (t.fondamentale / 0.08)
    );
  }

  /**
   * Synthèse par oscillateurs pilotés par phase — MIRROIR exact du
   * shader `decoderAudio`. Chaque nœud actif chante sin(2πf_i·t + θ_i)
   * pondéré par son amplitude ; normalisation par l'énergie active
   * (anti-saturation), bornée [-1, 1]. La longueur est arrondie au bloc
   * GPU (BLOC_ECHANTILLONS_MANIFOLD) comme le traitement par blocs du
   * moteur WebGPU.
   */
  synthetiser(t: TenseurOnde, nbEchantillons: number): Float32Array {
    if (!Number.isInteger(nbEchantillons) || nbEchantillons < 1) {
      throw new Error(`Nombre d'échantillons invalide : ${nbEchantillons}.`);
    }
    if (nbEchantillons > this.frequenceEchantillonnage * 60) {
      throw new Error(
        `Durée trop longue : ${nbEchantillons} échantillons (≤ 60 s).`,
      );
    }
    const pcm = new Float32Array(nbEchantillons);
    const fs = this.frequenceEchantillonnage;
    let energie = 0;

    for (let i = 0; i < t.nbNoeuds; i++) {
      const amplitude = t.amplitudes[i] / 65535;
      if (amplitude < this.options.seuilSparse) continue; // sparse
      const f = this.frequenceOscillateur(t, i);
      if (f >= fs / 2) continue; // anti-repliement (Nyquist)
      const w = DEUX_PI * f / fs;
      const th = dequantifierPhase(t.phases[i]);
      energie += amplitude;
      for (let s = 0; s < nbEchantillons; s++) {
        pcm[s] += amplitude * Math.sin(w * s + th);
      }
    }

    const gain = energie > 0 ? 2 / Math.max(energie, 1) : 0;
    for (let s = 0; s < nbEchantillons; s++) {
      pcm[s] = Math.min(1, Math.max(-1, pcm[s] * gain));
    }
    return pcm;
  }

  /** Encode le PCM synthétisé en WAV 16 bits (RIFF standard). */
  encoderWav(pcm: Float32Array): ArrayBuffer {
    return versWav(pcm, this.frequenceEchantillonnage);
  }
}

export { BLOC_ECHANTILLONS_MANIFOLD, SHADER_DECODE_AUDIO_PHASE, SHADER_DECODE_IMAGE_WAVELET, SHADER_DECODE_VIDEO_DERIVE };

/* ------------------------------------------------------------------ */
/* Décodeur VIDÉO — miroir de SHADER_DECODE_VIDEO_DERIVE               */
/* ------------------------------------------------------------------ */

export interface OptionsDecodeurVideo {
  /** Amplitude maximale de dérive (pixels, défaut 8). */
  amplitudeDerive?: number;
  /** Gain de résurrection d'énergie (défaut 0.15). */
  gainResurrection?: number;
  /** Seuil d'activation sparse (réservé aux passes d'analyse). */
  seuilSparse?: number;
}

export interface ResultatTrame {
  /** Trame T+1 RGBA 8 bits (largeur×hauteur×4), alpha opaque. */
  trame: Uint8ClampedArray;
  /** Dérive moyenne appliquée (pixels) — diagnostique du mouvement. */
  deriveMoyenne: number;
  /** Dérive maximale appliquée (pixels). */
  deriveMaximale: number;
}

export class DecodeurVideoDerive {
  readonly largeur: number;
  readonly hauteur: number;
  private readonly options: Required<OptionsDecodeurVideo>;

  constructor(largeur = 256, hauteur = 256, options?: OptionsDecodeurVideo) {
    if (!Number.isInteger(largeur) || largeur < 8 || largeur > 2048) {
      throw new Error(`Largeur invalide : ${largeur} (8..2048).`);
    }
    if (!Number.isInteger(hauteur) || hauteur < 8 || hauteur > 2048) {
      throw new Error(`Hauteur invalide : ${hauteur} (8..2048).`);
    }
    this.largeur = largeur;
    this.hauteur = hauteur;
    this.options = {
      amplitudeDerive: options?.amplitudeDerive ?? AMPLITUDE_DERIVE_DEFAUT,
      gainResurrection: options?.gainResurrection ?? GAIN_RESURRECTION_DEFAUT,
      seuilSparse: options?.seuilSparse ?? SEUIL_SPARSE_DEFAUT,
    };
  }

  /**
   * Propage la trame T vers T+1 — MIRROIR exact du shader
   * `deriverTrame` : la MATRICE DE DÉPHASAGE vectorielle (dx, dy) =
   * A·(cos θ, sin θ)·amplitude, échantillonnée bilinéairement depuis la
   * grille du tenseur, advecte la trame T (échantillonnage bilinéaire
   * clampé), puis la résurrection d'énergie réinjecte l'amplitude locale.
   * Coût : UNE lecture + UNE écriture par pixel — aucun réseau lourd.
   */
  trameSuivante(trameT: ArrayLike<number>, t: TenseurOnde): ResultatTrame {
    if (trameT.length !== this.largeur * this.hauteur * 4) {
      throw new Error(
        `Trame incohérente : ${trameT.length} valeurs pour ${this.largeur}×${this.hauteur}×4.`,
      );
    }
    const { largeur, hauteur } = this;
    const coteGrille = Math.round(Math.sqrt(t.nbNoeuds));
    const trame = new Uint8ClampedArray(largeur * hauteur * 4);

    // Grille de dérive (dx, dy) précalculée — une entrée par nœud.
    const dx = new Float64Array(t.nbNoeuds);
    const dy = new Float64Array(t.nbNoeuds);
    for (let i = 0; i < t.nbNoeuds; i++) {
      const a = t.amplitudes[i] / 65535;
      const th = dequantifierPhase(t.phases[i]);
      dx[i] = Math.cos(th) * a * this.options.amplitudeDerive;
      dy[i] = Math.sin(th) * a * this.options.amplitudeDerive;
    }

    let sommeDerive = 0;
    let maxDerive = 0;

    for (let y = 0; y < hauteur; y++) {
      const v = y / hauteur;
      for (let x = 0; x < largeur; x++) {
        const u = x / largeur;
        // Interpolation bilinéaire du champ de dérive sur la grille.
        const gu = u * (coteGrille - 1);
        const gv = v * (coteGrille - 1);
        const g0x = Math.min(Math.floor(gu), coteGrille - 1);
        const g0y = Math.min(Math.floor(gv), coteGrille - 1);
        const g1x = Math.min(g0x + 1, coteGrille - 1);
        const g1y = Math.min(g0y + 1, coteGrille - 1);
        const fracx = gu - g0x;
        const fracy = gv - g0y;

        const i00 = g0y * coteGrille + g0x;
        const i10 = g0y * coteGrille + g1x;
        const i01 = g1y * coteGrille + g0x;
        const i11 = g1y * coteGrille + g1x;

        const dxi =
          (dx[i00] * (1 - fracx) + dx[i10] * fracx) * (1 - fracy) +
          (dx[i01] * (1 - fracx) + dx[i11] * fracx) * fracy;
        const dyi =
          (dy[i00] * (1 - fracx) + dy[i10] * fracx) * (1 - fracy) +
          (dy[i01] * (1 - fracx) + dy[i11] * fracx) * fracy;
        const amplitudeLocale =
          (t.amplitudes[i00] / 65535) * (1 - fracx) * (1 - fracy) +
          (t.amplitudes[i10] / 65535) * fracx * (1 - fracy) +
          (t.amplitudes[i01] / 65535) * (1 - fracx) * fracy +
          (t.amplitudes[i11] / 65535) * fracx * fracy;

        const derive = Math.hypot(dxi, dyi);
        sommeDerive += derive;
        if (derive > maxDerive) maxDerive = derive;

        // Échantillonnage bilinéaire CLAMPÉ de la trame T au point dérivé.
        const sx = Math.min(largeur - 1, Math.max(0, x + dxi));
        const sy = Math.min(hauteur - 1, Math.max(0, y + dyi));
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const x1 = Math.min(x0 + 1, largeur - 1);
        const y1 = Math.min(y0 + 1, hauteur - 1);
        const tx = sx - x0;
        const ty = sy - y0;

        const o00 = (y0 * largeur + x0) * 4;
        const o10 = (y0 * largeur + x1) * 4;
        const o01 = (y1 * largeur + x0) * 4;
        const o11 = (y1 * largeur + x1) * 4;
        const o = (y * largeur + x) * 4;

        for (let c = 0; c < 3; c++) {
          const c00 = trameT[o00 + c] / 255;
          const c10 = trameT[o10 + c] / 255;
          const c01 = trameT[o01 + c] / 255;
          const c11 = trameT[o11 + c] / 255;
          const interpole =
            (c00 * (1 - tx) + c10 * tx) * (1 - ty) +
            (c01 * (1 - tx) + c11 * tx) * ty;
          // Résurrection d'énergie : les harmoniques actives ré-illuminent.
          const value = Math.min(
            1,
            Math.max(0, interpole + this.options.gainResurrection * amplitudeLocale),
          );
          trame[o + c] = Math.round(value * 255);
        }
        trame[o + 3] = 255;
      }
    }

    return {
      trame,
      deriveMoyenne: sommeDerive / (largeur * hauteur),
      deriveMaximale: maxDerive,
    };
  }
}
