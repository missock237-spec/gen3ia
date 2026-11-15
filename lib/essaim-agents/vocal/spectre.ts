/**
 * Voice-to-Wave — le spectre vocal devient une onde neuronale.
 *
 * La voix de l'utilisateur est captée dans le navigateur (getUserMedia
 * + AnalyserNode), fenêtrée (Hann), transformée par FFT radix-2 LOCALE
 * (aucune librairie, aucun service) et convertie en impulsions d'ondes
 * injectées dans le champ W-DNN : la parole devient littéralement de la
 * propagation d'ondes dans la grille d'oscillateurs. La réponse de
 * l'IA principale est synthétisée localement (SpeechSynthesis) avec une
 * prosodie modulée par la résonance — zéro API vocale tierce, zéro frais.
 */

/** Une composante spectrale dominante de la voix. */
export interface ImpulsionVocale {
  /** Fréquence centrale (Hz). */
  frequence: number;
  /** Amplitude normalisée ∈ [0, 1]. */
  amplitude: number;
  /** Phase mesurée (rad) — porte l'expressivité. */
  phase: number;
}

export interface OptionsSpectre {
  /** Nombre maximal de pics retenus (défaut 8). */
  maxPics?: number;
  /** Seuil relatif sous le pic principal (défaut 0.15). */
  seuilRelatif?: number;
  /** Plancher d'amplitude absolu (défaut 0.02). */
  plancher?: number;
}

const TAILLE_FFT_MIN = 256;
const TAILLE_FFT_MAX = 4096;

/** Fenêtre de Hann — réduit la fuite spectrale. */
export function fenetreHann(n: number): Float32Array {
  const fenetre = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    fenetre[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return fenetre;
}

/**
 * FFT radix-2 itérative (Cooley-Tukey) — O(n log n), zéro allocation
 * par appel au-delà des tableaux de travail réutilisables.
 */
export function fftRadix2(
  reel: Float32Array,
  imag: Float32Array,
): void {
  const n = reel.length;
  if (n < 2 || (n & (n - 1)) !== 0) {
    throw new Error(`FFT radix-2 exige une puissance de 2 (reçu ${n}).`);
  }

  // Permutation bit-reversal.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = reel[i]; reel[i] = reel[j]; reel[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
  }

  // Papillons.
  for (let taille = 2; taille <= n; taille <<= 1) {
    const pas = (2 * Math.PI) / taille;
    for (let i = 0; i < n; i += taille) {
      for (let k = 0; k < taille / 2; k++) {
        const angle = pas * k;
        const wr = Math.cos(angle);
        const wi = -Math.sin(angle);
        const i1 = i + k;
        const i2 = i1 + taille / 2;
        const tr = reel[i2] * wr - imag[i2] * wi;
        const ti = reel[i2] * wi + imag[i2] * wr;
        reel[i2] = reel[i1] - tr;
        imag[i2] = imag[i1] - ti;
        reel[i1] += tr;
        imag[i1] += ti;
      }
    }
  }
}

/** Force un tableau à la taille FFT (tronque/zéro-padge). */
function ajuster(echantillons: Float32Array, taille: number): Float32Array {
  const sorti = new Float32Array(taille);
  const copie = Math.min(echantillons.length, taille);
  for (let i = 0; i < copie; i++) sorti[i] = echantillons[i];
  return sorti;
}

/** Puissance de 2 immédiatement supérieure ou égale (dans les bornes). */
function tailleFftPour(longueur: number): number {
  let taille = TAILLE_FFT_MIN;
  while (taille < longueur && taille < TAILLE_FFT_MAX) taille <<= 1;
  return taille;
}

/**
 * Analyse un trame d'échantillons (PCM float mono) et renvoie les
 * impulsions vocales dominantes : les pics du spectre de magnitude,
 * normalisés, avec leur phase.
 */
export function analyserSpectre(
  echantillons: Float32Array,
  options?: OptionsSpectre,
): ImpulsionVocale[] {
  const maxPics = Math.max(1, Math.min(16, options?.maxPics ?? 8));
  const seuilRelatif = options?.seuilRelatif ?? 0.15;
  const plancher = options?.plancher ?? 0.02;

  if (echantillons.length < TAILLE_FFT_MIN) return [];
  const n = tailleFftPour(echantillons.length);
  const trame = ajuster(echantillons, n);
  const fenetre = fenetreHann(n);

  const reel = new Float32Array(n);
  const imag = new Float32Array(n);
  let energie = 0;
  for (let i = 0; i < n; i++) {
    reel[i] = trame[i] * fenetre[i];
    energie += reel[i] * reel[i];
  }
  // Silence : pas d'impulsion (l'onde n'est pas excitée).
  if (energie / n < plancher * plancher) return [];

  fftRadix2(reel, imag);

  // Magnitudes (moitié utile : symétrie hermitienne du signal réel).
  const moitie = n >> 1;
  const magnitudes = new Float32Array(moitie);
  let maximum = 0;
  for (let k = 1; k < moitie; k++) {
    const m = Math.hypot(reel[k], imag[k]) / (n / 4);
    magnitudes[k] = m;
    if (m > maximum) maximum = m;
  }
  if (maximum <= 0) return [];

  // Pics locaux (un maximum entre deux voisins), triés par magnitude.
  const pics: Array<{ bin: number; m: number; phase: number }> = [];
  for (let k = 2; k < moitie - 1; k++) {
    const m = magnitudes[k];
    if (m >= magnitudes[k - 1] && m >= magnitudes[k + 1] && m >= maximum * seuilRelatif) {
      pics.push({ bin: k, m, phase: Math.atan2(imag[k], reel[k]) });
    }
  }
  pics.sort((a, b) => b.m - a.m);

  return pics.slice(0, maxPics).map((pic) => ({
    frequence: pic.bin,
    amplitude: Math.min(1, pic.m / maximum),
    phase: pic.phase,
  }));
}

/**
 * Convertit les impulsions vocales en impulsions du champ W-DNN :
 * la fréquence (Hz → bin) devient une POSITION dans la grille (mapping
 * logarithmique, comme la perception), l'amplitude et la phase sont
 * transportées telles quelles.
 */
export function versImpulsionsOndes(
  impulsions: ImpulsionVocale[],
  largeur: number,
  hauteur: number,
  tailleFft = TAILLE_FFT_MAX,
): Array<{ x: number; y: number; amplitude: number; frequence: number; phase: number; rayon: number }> {
  return impulsions.map((impulsion) => {
    // Mapping perceptuel : les graves à gauche, les aigus à droite,
    // position logarithmique dans la largeur de la grille.
    const t = Math.min(1, Math.log2(1 + impulsion.frequence) / Math.log2(1 + tailleFft / 2));
    const x = Math.max(1, Math.min(largeur - 2, t * (largeur - 2) + 1));
    const y = hauteur / 2 + Math.sin(impulsion.phase) * (hauteur / 4);
    return {
      x,
      y: Math.max(1, Math.min(hauteur - 2, y)),
      amplitude: impulsion.amplitude,
      frequence: Math.max(0.02, Math.min(0.2, 0.02 + impulsion.frequence / tailleFft * 0.18)),
      phase: impulsion.phase,
      rayon: 1.5 + impulsion.amplitude * 2.5,
    };
  });
}

/**
 * Prosodie de synthèse : la résonance du champ module la voix locale.
 * r ∈ [0, 1] (ordre de Kuramoto), énergie ∈ [0, 1] — la voix « vibre »
 * avec l'essaim.
 */
export function prosodieDepuisResonance(
  ordreR: number,
  energie: number,
): { pitch: number; rate: number } {
  const pitch = 0.9 + Math.min(0.3, ordreR * 0.3 + energie * 0.1);
  const rate = 0.95 + Math.min(0.25, energie * 0.25);
  return { pitch: Math.round(pitch * 100) / 100, rate: Math.round(rate * 100) / 100 };
}
