/**
 * MANIFOLD COMMUN D'ONDES (Tenseur d'Onde Commun) — Phase 1 de
 * l'intégration multimodale au cœur de l'architecture W-DNN.
 *
 * TOUTES les modalités (texte, audio, image, vidéo) partagent désormais
 * UN MÊME format mathématique : un champ d'oscillateurs complexes
 * [amplitude, phase] accrochés à une fréquence fondamentale F0. Là où un
 * pipeline classique traîne des matrices denses FP32/FP16 (8 octets par
 * état complexe en FP32), le tenseur quantifié porte chaque état en
 * DEUX Uint16 — 4 octets par état, 50 % de mémoire en moins, et des
 * tampons directement mappables dans des buffers GPU (uniform/storage)
 * sans re-conditionnement.
 *
 * Physique du format :
 *  · état i = A_i · e^{i·θ_i}, A ∈ [0, 1] quantifié sur 16 bits,
 *    θ ∈ [0, 2π) quantifié sur 16 bits (résolution 2π/65536 ≈ 9,6·10⁻⁵ rad) ;
 *  · la fondamentale F0 (rad/pas) est commune : l'harmonique k du nœud i
 *    oscille à F0 · k — c'est l'« encodeur multi-fréquence » : les jetons
 *    textuels ou les commandes API modulent F0 et les harmoniques,
 *    jamais des poids denses ;
 *  · la superposition de deux états est une SOMME COMPLEXE : interférence
 *    constructive (phases proches) ou destructive (phases opposées) — la
 *    fusion de deux modalités est donc une opération physique, pas une
 *    concaténation de tenseurs.
 *
 * Module PUR : aucune dépendance Node ni navigateur. Déterministe :
 * même entrée → même tenseur bit à bit (hash FNV-1a, aucune Math.random).
 */

import { fnv1a } from "./encodeur";

/** Résolution de phase : 2π répartis sur 65 536 crans (Uint16). */
export const PHASE_CRANS = 65536;

/** Résolution d'amplitude : [0, 1] réparti sur 65 536 crans (Uint16). */
export const AMPLITUDE_CRANS = 65536;

/** Deux π (évite de recalculer partout). */
export const DEUX_PI = Math.PI * 2;

/**
 * Octets par état dans le tenseur quantifié (1 Uint16 amplitude +
 * 1 Uint16 phase) — contre 8 octets pour le couple FP32 équivalent.
 */
export const OCTETS_PAR_ETAT = 4;

/** Octets par état d'un couple dense FP32 (amplitude + phase). */
export const OCTETS_PAR_ETAT_FP32 = 8;

/* ------------------------------------------------------------------ */
/* Quantification                                                      */
/* ------------------------------------------------------------------ */

/** Quantifie une amplitude [0, 1] en cran Uint16 (bornée, finie). */
export function quantifierAmplitude(amplitude: number): number {
  if (!Number.isFinite(amplitude)) return 0;
  const a = Math.min(1, Math.max(0, amplitude));
  return Math.round(a * (AMPLITUDE_CRANS - 1));
}

/** Déquantifie un cran Uint16 en amplitude [0, 1]. */
export function dequantifierAmplitude(cran: number): number {
  return cran / (AMPLITUDE_CRANS - 1);
}

/** Quantifie une phase (rad, quelconque) en cran Uint16 ∈ [0, 2π). */
export function quantifierPhase(phase: number): number {
  if (!Number.isFinite(phase)) return 0;
  const normalisee = ((phase % DEUX_PI) + DEUX_PI) % DEUX_PI;
  return Math.round((normalisee / DEUX_PI) * (PHASE_CRANS - 1)) % PHASE_CRANS;
}

/** Déquantifie un cran Uint16 en phase ∈ [0, 2π). */
export function dequantifierPhase(cran: number): number {
  return (cran / (PHASE_CRANS - 1)) * DEUX_PI;
}

/** Erreur maximale de quantification de phase (rad) — précision du format. */
export const ERREUR_PHASE_MAX = DEUX_PI / (PHASE_CRANS - 1);

/** Erreur maximale de quantification d'amplitude — précision du format. */
export const ERREUR_AMPLITUDE_MAX = 1 / (AMPLITUDE_CRANS - 1);

/* ------------------------------------------------------------------ */
/* Tenseur d'onde commun                                               */
/* ------------------------------------------------------------------ */

/**
 * Le tenseur d'onde commun : N états complexes quantifiés accrochés à
 * une fondamentale. Les tampons `amplitudes`/`phases` se mappent TELS
 * QUELS en buffers WebGPU (format `uint16x2` / deux `u32` paquets).
 */
export interface TenseurOnde {
  /** Nombre d'états (nœuds / harmoniques porteuses). */
  readonly nbNoeuds: number;
  /** Fréquence fondamentale commune (rad/pas) — le « ton » du tenseur. */
  readonly fondamentale: number;
  /** Amplitudes quantifiées (Uint16, crans 0..65535). */
  readonly amplitudes: Uint16Array;
  /** Phases quantifiées (Uint16, crans 0..65535 → [0, 2π)). */
  readonly phases: Uint16Array;
}

/** Taille mémoire du tenseur quantifié en octets. */
export function octetsTenseur(nbNoeuds: number): number {
  return nbNoeuds * OCTETS_PAR_ETAT;
}

/** Taille mémoire du même état en couple dense FP32 (référence). */
export function octetsEquivalentFlottant(nbNoeuds: number): number {
  return nbNoeuds * OCTETS_PAR_ETAT_FP32;
}

/** Crée un tenseur quantifié depuis des états flottants (bornés). */
export function creerTenseur(
  amplitudes: ArrayLike<number>,
  phases: ArrayLike<number>,
  fondamentale: number,
): TenseurOnde {
  if (amplitudes.length !== phases.length) {
    throw new Error(
      `Manifold incohérent : ${amplitudes.length} amplitudes vs ${phases.length} phases.`,
    );
  }
  if (!Number.isFinite(fondamentale) || fondamentale <= 0) {
    throw new Error(`Fondamentale invalide : ${fondamentale} (> 0 requis).`);
  }
  const n = amplitudes.length;
  const a = new Uint16Array(n);
  const p = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = quantifierAmplitude(amplitudes[i]);
    p[i] = quantifierPhase(phases[i]);
  }
  return { nbNoeuds: n, fondamentale, amplitudes: a, phases: p };
}

/** Copie défensive d'un tenseur. */
export function clonerTenseur(t: TenseurOnde): TenseurOnde {
  return {
    nbNoeuds: t.nbNoeuds,
    fondamentale: t.fondamentale,
    amplitudes: t.amplitudes.slice(),
    phases: t.phases.slice(),
  };
}

/** Déquantifie le tenseur en états flottants (consommation CPU/GPU). */
export function dequantifierTenseur(t: TenseurOnde): {
  amplitudes: Float64Array;
  phases: Float64Array;
} {
  const a = new Float64Array(t.nbNoeuds);
  const p = new Float64Array(t.nbNoeuds);
  for (let i = 0; i < t.nbNoeuds; i++) {
    a[i] = dequantifierAmplitude(t.amplitudes[i]);
    p[i] = dequantifierPhase(t.phases[i]);
  }
  return { amplitudes: a, phases: p };
}

/* ------------------------------------------------------------------ */
/* Superposition complexe (fusion de modalités)                        */
/* ------------------------------------------------------------------ */

export interface EtatComplexe {
  amplitude: number;
  phase: number;
}

/**
 * Superposition de deux états complexes — LE cœur physique du manifold :
 * A₁·e^{iθ₁} + A₂·e^{iθ₂}. Deux phases alignées s'additionnent
 * (résonance constructive), deux phases opposées s'annulent
 * (interférence destructive). Déterministe, exact.
 */
export function superposer(e1: EtatComplexe, e2: EtatComplexe): EtatComplexe {
  const re = e1.amplitude * Math.cos(e1.phase) + e2.amplitude * Math.cos(e2.phase);
  const im = e1.amplitude * Math.sin(e1.phase) + e2.amplitude * Math.sin(e2.phase);
  return { amplitude: Math.hypot(re, im), phase: Math.atan2(im, re) };
}

/**
 * Fusionne deux tenseurs (même taille, fondamentales DIFFÉRENTES admises :
 * la fondamentale résultante est la moyenne géométrique — la fusion de
 * deux « tons » reste un ton). Chaque état est la superposition complexe
 * des deux états source. C'est ainsi que texte + image coexistent dans
 * UN champ, sans concaténation de matrices.
 */
export function fusionnerTenseurs(t1: TenseurOnde, t2: TenseurOnde): TenseurOnde {
  if (t1.nbNoeuds !== t2.nbNoeuds) {
    throw new Error(
      `Fusion impossible : ${t1.nbNoeuds} vs ${t2.nbNoeuds} nœuds (mêmes dimensions requises).`,
    );
  }
  const d1 = dequantifierTenseur(t1);
  const d2 = dequantifierTenseur(t2);
  const a = new Float64Array(t1.nbNoeuds);
  const p = new Float64Array(t1.nbNoeuds);
  for (let i = 0; i < t1.nbNoeuds; i++) {
    const s = superposer(
      { amplitude: d1.amplitudes[i], phase: d1.phases[i] },
      { amplitude: d2.amplitudes[i], phase: d2.phases[i] },
    );
    a[i] = s.amplitude;
    p[i] = s.phase;
  }
  return creerTenseur(
    a,
    p,
    Math.sqrt(Math.max(1e-12, t1.fondamentale * t2.fondamentale)),
  );
}

/**
 * Paramètre d'ordre de Kuramoto du tenseur : r = |Σ A_i·e^{iθ_i}| / Σ A_i
 * ∈ [0, 1]. r ≈ 1 : le champ est cohérent (toutes les phases alignées) ;
 * r ≈ 0 : le champ est incohérent (phases dispersées). C'est la mesure
 * universelle de « netteté » d'un état multimodal.
 */
export function ordreKuramoto(t: TenseurOnde): number {
  const d = dequantifierTenseur(t);
  let re = 0;
  let im = 0;
  let somme = 0;
  for (let i = 0; i < t.nbNoeuds; i++) {
    const a = d.amplitudes[i];
    re += a * Math.cos(d.phases[i]);
    im += a * Math.sin(d.phases[i]);
    somme += a;
  }
  if (somme === 0) return 0;
  return Math.hypot(re, im) / somme;
}

/** Énergie totale du tenseur (Σ A_i²) — l'intensité du champ. */
export function energieTenseur(t: TenseurOnde): number {
  let e = 0;
  for (let i = 0; i < t.nbNoeuds; i++) {
    const a = dequantifierAmplitude(t.amplitudes[i]);
    e += a * a;
  }
  return e;
}

/* ------------------------------------------------------------------ */
/* Encodeur multi-fréquence (jetons → harmoniques de F0)               */
/* ------------------------------------------------------------------ */

export interface OptionsEncodeurMulti {
  /** Fréquence fondamentale de base (rad/pas) — défaut 0.08 (bande utile). */
  fondamentaleBase?: number;
  /** Nombre d'harmoniques par jeton (défaut 4). */
  harmoniquesParJeton?: number;
  /** Décroissance spectrale des harmoniques (défaut 1/k — série de Fourier). */
  penteSpectrale?: number;
}

export const ENCODEUR_MULTI_DEFAUTS: Required<OptionsEncodeurMulti> = {
  fondamentaleBase: 0.08,
  harmoniquesParJeton: 4,
  penteSpectrale: 1,
};

export interface Harmonique {
  /** Rang harmonique k ≥ 1 (oscille à F0 · k). */
  readonly rang: number;
  /** Fondamentale du jeton porteur (F0_j = F0_base · 2^octave). */
  readonly fondamentale: number;
  readonly amplitude: number;
  readonly phase: number;
  /** Identifiant du jeton porteur (traçabilité multimodale). */
  readonly jeton: string;
}

/**
 * ENCODEUR MULTI-FRÉQUENCE — un jeton ne devient PAS un vecteur dense :
 * il module la fondamentale et ses harmoniques. Le hash FNV-1a (déjà
 * l'invariant déterministe de l'encodeur de texte W-DNN) décide de :
 *  · l'octave : F0_j = F0_base · 2^(h mod 3) — trois registres, comme
 *    des voix ;
 *  · la phase initiale θ_j (cercle complet) ;
 *  · l'enveloppe harmonique : A_k = A_j / k^pente (série de Fourier — le
 *    timbre du jeton).
 * Le même jeton produit TOUJOURS les mêmes harmoniques : le manifold est
 * réversible par conception (carte inverse possible).
 */
export function jetonVersHarmoniques(
  jeton: string,
  options?: Partial<OptionsEncodeurMulti>,
): Harmonique[] {
  const opts = { ...ENCODEUR_MULTI_DEFAUTS, ...options };
  const h1 = fnv1a(jeton);
  const h2 = fnv1a(`manifold·${jeton}`);
  const h3 = fnv1a(`phase·${jeton}`);
  const octave = h1 % 3;
  const fondamentaleJeton = opts.fondamentaleBase * Math.pow(2, octave);
  const phaseJeton = (h3 / 0xffffffff) * DEUX_PI;
  const energieJeton = 0.5 + (h2 % 512) / 1024; // ∈ [0.5, ~1.0)

  const harmoniques: Harmonique[] = [];
  for (let k = 1; k <= opts.harmoniquesParJeton; k++) {
    harmoniques.push({
      rang: k,
      fondamentale: fondamentaleJeton,
      amplitude: energieJeton / Math.pow(k, opts.penteSpectrale),
      phase: phaseJeton + k * (h2 % 64) * 0.01,
      jeton,
    });
  }
  return harmoniques;
}

/** F0 effective d'un texte : moyenne des fondamentales de ses jetons. */
export function fondamentaleDepuisTexte(
  texte: string,
  options?: Partial<OptionsEncodeurMulti>,
): { fondamentale: number; jetons: string[] } {
  const jetons =
    texte
      .match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)
      ?.map((m) => m.toLocaleLowerCase("fr"))
      .filter((m) => m.length > 0) ?? [];
  if (jetons.length === 0) {
    throw new Error("Texte vide : rien à encoder dans le manifold.");
  }
  const opts = { ...ENCODEUR_MULTI_DEFAUTS, ...options };
  let somme = 0;
  for (const jeton of jetons) {
    somme += opts.fondamentaleBase * Math.pow(2, fnv1a(jeton) % 3);
  }
  return { fondamentale: somme / jetons.length, jetons };
}

/**
 * Texte → tenseur d'onde commun. Chaque jeton dépose ses harmoniques
 * dans des créneaux déterministes du tenseur (rotation modulo N pour ne
 * jamais saturer) ; les collisions se résolvent PAR PHYSIQUE
 * (superposition complexe), pas par écrasement.
 */
export function texteVersTenseur(
  texte: string,
  nbNoeuds = 256,
  options?: Partial<OptionsEncodeurMulti>,
): TenseurOnde {
  if (!Number.isInteger(nbNoeuds) || nbNoeuds < 16 || nbNoeuds > 65536) {
    throw new Error(`Nombre de nœuds invalide : ${nbNoeuds} (16..65536).`);
  }
  const opts = { ...ENCODEUR_MULTI_DEFAUTS, ...options };
  const { fondamentale, jetons } = fondamentaleDepuisTexte(texte, opts);

  // Accumulateurs complexes (fusion physique des collisions).
  const re = new Float64Array(nbNoeuds);
  const im = new Float64Array(nbNoeuds);

  let creneau = 0;
  for (const jeton of jetons) {
    for (const h of jetonVersHarmoniques(jeton, opts)) {
      const i = creneau % nbNoeuds;
      creneau++;
      re[i] += h.amplitude * Math.cos(h.phase);
      im[i] += h.amplitude * Math.sin(h.phase);
    }
  }

  const amplitudes = new Float64Array(nbNoeuds);
  const phases = new Float64Array(nbNoeuds);
  for (let i = 0; i < nbNoeuds; i++) {
    amplitudes[i] = Math.hypot(re[i], im[i]);
    phases[i] = Math.atan2(im[i], re[i]);
  }
  return creerTenseur(amplitudes, phases, fondamentale);
}

/* ------------------------------------------------------------------ */
/* Conversions modalité ↔ manifold                                     */
/* ------------------------------------------------------------------ */

/**
 * PCM mono [-1, 1] → tenseur : démodulation cohérente. Le signal est
 * découpé en `nbNoeuds` fenêtres contiguës ; chaque fenêtre est battue
 * avec la porteuse F0 (somme des sin/cos pondérés) :
 *  · amplitude_i = RMS de la fenêtre (énergie locale, normalisée) ;
 *  · phase_i = atan2(Σ s·sin, Σ s·cos) — déphasage mesuré sur une
 *    PORTEUSE EN COSINUS (un cosinus pur en phase → 0, testé). Avec la
 *    convention de synthèse sin(2πft + θ), c'est l'image miroir
 *    θ ↦ π/2 − θ : contenu et énergie conservés, phase réfléchie.
 */
export function echantillonsVersTenseur(
  pcm: ArrayLike<number>,
  nbNoeuds = 256,
  fondamentale = 0.08,
): TenseurOnde {
  if (!Number.isInteger(nbNoeuds) || nbNoeuds < 16) {
    throw new Error(`Nombre de nœuds invalide : ${nbNoeuds} (≥ 16).`);
  }
  if (pcm.length < nbNoeuds) {
    throw new Error(`Signal trop court : ${pcm.length} échantillons pour ${nbNoeuds} nœuds.`);
  }
  const tailleFenetre = Math.floor(pcm.length / nbNoeuds);
  const w = DEUX_PI * fondamentale;

  // Passe 1 : RMS bruts (pour normaliser ensuite).
  const rms = new Float64Array(nbNoeuds);
  const cos = new Float64Array(nbNoeuds);
  const sin = new Float64Array(nbNoeuds);
  for (let i = 0; i < nbNoeuds; i++) {
    let e = 0;
    let c = 0;
    let s = 0;
    for (let j = 0; j < tailleFenetre; j++) {
      const v = pcm[i * tailleFenetre + j];
      e += v * v;
      const angle = w * j;
      c += v * Math.cos(angle);
      s += v * Math.sin(angle);
    }
    rms[i] = Math.sqrt(e / tailleFenetre);
    cos[i] = c;
    sin[i] = s;
  }

  // Passe 2 : normalisation par le RMS maximal (amplitude ∈ [0, 1]).
  let rmsMax = 0;
  for (let i = 0; i < nbNoeuds; i++) rmsMax = Math.max(rmsMax, rms[i]);
  const amplitudes = new Float64Array(nbNoeuds);
  const phases = new Float64Array(nbNoeuds);
  for (let i = 0; i < nbNoeuds; i++) {
    amplitudes[i] = rmsMax > 0 ? rms[i] / rmsMax : 0;
    phases[i] = Math.atan2(sin[i], cos[i]);
  }
  return creerTenseur(amplitudes, phases, fondamentale);
}

/**
 * Tenseur → PCM mono (synthèse additive) : chaque nœud chante son
 * harmonique de fondamentale (f_i = F0 · (1 + i/N)), piloté par SA phase
 * quantifiée. C'est le miroir CPU de SHADER_DECODE_AUDIO_PHASE — le
 * décodeur audio de la Phase 2 réutilise ce contrat.
 */
export function tenseurVersEchantillons(
  t: TenseurOnde,
  nbEchantillons: number,
  frequenceEchantillonnage = 44100,
): Float32Array {
  if (!Number.isInteger(nbEchantillons) || nbEchantillons < 1) {
    throw new Error(`Nombre d'échantillons invalide : ${nbEchantillons}.`);
  }
  const d = dequantifierTenseur(t);
  const pcm = new Float32Array(nbEchantillons);
  for (let i = 0; i < t.nbNoeuds; i++) {
    const f = t.fondamentale * (1 + i / t.nbNoeuds) * frequenceEchantillonnage;
    if (f >= frequenceEchantillonnage / 2) continue; // anti-repliement (Nyquist)
    const w = DEUX_PI * f / frequenceEchantillonnage;
    const a = d.amplitudes[i];
    const th = d.phases[i];
    for (let s = 0; s < nbEchantillons; s++) {
      pcm[s] += a * Math.sin(w * s + th);
    }
  }
  // Normalisation douce (évite la saturation quand toutes les phases s'alignent).
  let max = 0;
  for (let s = 0; s < nbEchantillons; s++) max = Math.max(max, Math.abs(pcm[s]));
  const gain = max > 1 ? 1 / max : 1;
  for (let s = 0; s < nbEchantillons; s++) pcm[s] *= gain;
  return pcm;
}

export interface OptionsImageTenseur {
  /** Graine déterministe du dithering de couverture (défaut 7). */
  graine?: number;
}

/**
 * Image RGBA (grayscale interne : luminance) → tenseur : chaque nœud
 * analyse un bloc ; amplitude_i = CONTRASTE du bloc (écart-type de la
 * luminance, normalisé — un bloc plat ne résonne pas), phase_i =
 * ORIENTATION du gradient moyen (atan2(gy, gx)) : une arête horizontale,
 * verticale ou diagonale devient une phase. C'est l'analyse ondelette de
 * Haar exprimée en langage d'ondes (différence = bande passante).
 */
export function imageVersTenseur(
  pixels: ArrayLike<number>,
  largeur: number,
  hauteur: number,
  nbNoeuds = 256,
  options?: OptionsImageTenseur,
): TenseurOnde {
  if (pixels.length !== largeur * hauteur * 4) {
    throw new Error(
      `Tampon image incohérent : ${pixels.length} valeurs pour ${largeur}×${hauteur}×4.`,
    );
  }
  if (!Number.isInteger(nbNoeuds) || nbNoeuds < 16) {
    throw new Error(`Nombre de nœuds invalide : ${nbNoeuds} (≥ 16).`);
  }
  const coteGrille = Math.round(Math.sqrt(nbNoeuds));
  const grille = coteGrille * coteGrille;

  const amplitudes = new Float64Array(grille);
  const phases = new Float64Array(grille);
  const blocW = largeur / coteGrille;
  const blocH = hauteur / coteGrille;

  let contrasteMax = 0;
  for (let by = 0; by < coteGrille; by++) {
    for (let bx = 0; bx < coteGrille; bx++) {
      const i = by * coteGrille + bx;
      const x0 = Math.floor(bx * blocW);
      const x1 = Math.max(x0 + 1, Math.floor((bx + 1) * blocW));
      const y0 = Math.floor(by * blocH);
      const y1 = Math.max(y0 + 1, Math.floor((by + 1) * blocH));

      let somme = 0;
      let sommeCarre = 0;
      let n = 0;
      let gx = 0;
      let gy = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * largeur + x) * 4;
          const lum =
            0.2126 * pixels[o] + 0.7152 * pixels[o + 1] + 0.0722 * pixels[o + 2];
          somme += lum;
          sommeCarre += lum * lum;
          n++;
          if (x + 1 < x1) gx += pixels[o + 4] - pixels[o];
          if (y + 1 < y1) gy += pixels[o + largeur * 4] - pixels[o];
        }
      }
      const moyenne = somme / n;
      const variance = sommeCarre / n - moyenne * moyenne;
      const contraste = Math.sqrt(Math.max(0, variance)) / 255;
      amplitudes[i] = contraste;
      contrasteMax = Math.max(contrasteMax, contraste);
      // Orientation du gradient : le dithering déterministe lève le cas
      // dégénéré (gradient nul) sans Math.random.
      const graine = options?.graine ?? 7;
      const dither = (((fnv1a(`grain·${i}·${graine}`) % 1000) - 500) / 500) * 1e-3;
      phases[i] = Math.atan2(gy + dither, gx + dither);
    }
  }

  // Normalisation par le contraste maximal.
  if (contrasteMax > 0) {
    for (let i = 0; i < grille; i++) amplitudes[i] /= contrasteMax;
  }
  return creerTenseur(amplitudes, phases, ENCODEUR_MULTI_DEFAUTS.fondamentaleBase);
}

/**
 * Trame vidéo = image + champ de dérive temporel : la composante
 * vidéo du manifold porte la TRAME COURANTE (comme une image) ; le
 * MOUVEMENT vers T+1 est porté par la MÊME structure (les phases
 * deviennent les vecteurs de dérive du décodeur vidéo — Phase 2).
 * Cette fonction est l'entrée d'analyse d'une trame.
 */
export function trameVersTenseur(
  trame: ArrayLike<number>,
  largeur: number,
  hauteur: number,
  nbNoeuds = 256,
  options?: OptionsImageTenseur,
): TenseurOnde {
  return imageVersTenseur(trame, largeur, hauteur, nbNoeuds, options);
}
