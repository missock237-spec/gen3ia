/**
 * HARNAIS DE PERFORMANCE — Phase 4 : mesurer la LATENCE réelle et
 * estimer la CONSOMMATION (Watts) de la génération d'ondes, et la
 * comparer à une approche LLM/réseau de diffusion classique.
 *
 * HONNÊTETÉ DES MESURES — deux catégories STRICTEMENT séparées :
 *  · MESURÉ : la latence du miroir CPU (performance.now autour du calcul
 *    réel), le nombre d'opérations exécutées — reproductibles partout ;
 *  · ESTIMÉ : la consommation électrique. Aucun wattmètre n'est dans le
 *    navigateur : le modèle énergétique est une ESTIMATION calibrée sur
 *    des consommations publiques de SoC mobiles (GPU ~2–5 W en charge
 *    compute, CPU efficiency cores ~1–3 W). Chaque chiffre porte sa
 *    méthode (`methode: "estimation-calibree"`), jamais un faux « mesuré ».
 */

import type { TenseurOnde } from "./manifold";
import { compterActivationSparse } from "./optimisation";

/* ------------------------------------------------------------------ */
/* Latence (mesurée)                                                   */
/* ------------------------------------------------------------------ */

export interface MesureLatence {
  /** Médiane des latences (ms). */
  latenceMs: number;
  /** Minimum (ms) — le meilleur passage. */
  minMs: number;
  /** Maximum (ms). */
  maxMs: number;
  /** Nombre d'échantillons de mesure. */
  echantillons: number;
  /** Toujours "mesuree" — les latences sont RÉELLES. */
  methode: "mesuree";
}

/** Mesure la latence d'une fonction pure (médiane de n passages). */
export function mesurerLatence(fn: () => void, echantillons = 5): MesureLatence {
  if (!Number.isInteger(echantillons) || echantillons < 1) {
    throw new Error(`Nombre d'échantillons invalide : ${echantillons}.`);
  }
  const relevés: number[] = [];
  for (let i = 0; i < echantillons; i++) {
    const debut = performance.now();
    fn();
    relevés.push(performance.now() - debut);
  }
  relevés.sort((a, b) => a - b);
  const milieu = Math.floor(relevés.length / 2);
  return {
    latenceMs:
      relevés.length % 2 === 1
        ? relevés[milieu]
        : (relevés[milieu - 1] + relevés[milieu]) / 2,
    minMs: relevés[0],
    maxMs: relevés[relevés.length - 1],
    echantillons,
    methode: "mesuree",
  };
}

/* ------------------------------------------------------------------ */
/* Modèle énergétique (estimation calibrée)                            */
/* ------------------------------------------------------------------ */

/**
 * Opérations par seconde par watt — calibrations d'ORDRE DE GRANDEUR sur
 * des consommations publiques de SoC mobiles (documents constructeurs et
 * benchmarks publics ; `methode: "estimation-calibree"`). Chiffres
 * volontairement conservateurs :
 *  · GPU WebGPU mobile : ~4 W en charge compute, ~50 Goops/s int →
 *    ~12,5 Goops/W ;
 *  · CPU mobile (cœurs efficience) : ~2 W, ~5 Goops/s → ~2,5 Goops/W.
 */
export const CALIBRATIONS_ENERGIE = {
  webgpu: { wattsCharge: 4, goopsParSeconde: 50 },
  cpu: { wattsCharge: 2, goopsParSeconde: 5 },
} as const;

export type MoteurEnergetique = keyof typeof CALIBRATIONS_ENERGIE;

export interface EstimationEnergie {
  /** Opérations totales du calcul soumis. */
  ops: number;
  /** Puissance moyenne pendant le calcul (W). */
  wattsMoyens: number;
  /** Énergie totale du calcul (J). */
  joules: number;
  /** Toujours "estimation-calibree" — jamais de faux « mesuré ». */
  methode: "estimation-calibree";
  /** Détail de la calibration utilisée. */
  calibration: { wattsCharge: number; goopsParSeconde: number };
}

/**
 * Estime l'énergie d'un calcul de `ops` opérations sur `moteur`.
 * Puissance proportionnelle à l'occupation : le GPU mobile ne descend
 * pas sous ~30 % de sa charge en mode compute (hypothèse conservatrice
 * du modèle).
 */
export function estimerEnergie(
  ops: number,
  moteur: MoteurEnergetique,
  dureeMs?: number,
): EstimationEnergie {
  if (!Number.isFinite(ops) || ops < 0) {
    throw new Error(`Nombre d'opérations invalide : ${ops}.`);
  }
  const cal = CALIBRATIONS_ENERGIE[moteur];
  const opsParSeconde = cal.goopsParSeconde * 1e9;
  // Occupation = fraction de la fenêtre de charge nécessaire ; borne [0.3, 1].
  const dureeSeconde = dureeMs !== undefined ? dureeMs / 1000 : ops / opsParSeconde;
  const occupation = Math.min(1, Math.max(0.3, (ops / opsParSeconde) / Math.max(dureeSeconde, 1e-9)));
  const watts = cal.wattsCharge * occupation;
  return {
    ops,
    wattsMoyens: watts,
    joules: watts * dureeSeconde,
    methode: "estimation-calibree",
    calibration: { wattsCharge: cal.wattsCharge, goopsParSeconde: cal.goopsParSeconde },
  };
}

/* ------------------------------------------------------------------ */
/* Comparaison ondes ↔ pipeline dense                                  */
/* ------------------------------------------------------------------ */

export interface ComparaisonOndesDense {
  nbNoeuds: number;
  /** Nœuds actifs (sparse) réellement calculés. */
  noeudsActifs: number;
  /** Sortie produite (pixels ou échantillons). */
  tailleSortie: number;
  /** Ops de la génération d'ondes (sparse : actifs × sortie). */
  opsOndes: number;
  /** Ops du pipeline dense de référence — ORDRE DE GRANDEUR documenté. */
  opsDenseReference: number;
  /** Ratio dense/ondes (≥ 1 = les ondes gagnent). */
  ratio: number;
  /** Méthode de l'estimation dense (honnêteté). */
  methode: "ordre-de-grandeur-reference";
}

/**
 * Référence dense : un réseau de diffusion miniature (UNet ~10⁹ ops
 * par image 256², ordre de grandeur public des diffusion text-to-image
 * allégées) ou un vocoder neuronal (~10⁸ ops·s⁻¹). C'est une référence
 * de GRANDEUR, pas un modèle nommé — étiquetée comme telle.
 */
export const OPS_DENSE_REFERENCE_PAR_IMAGE = 1e9;
export const OPS_DENSE_REFERENCE_PAR_SECONDE_AUDIO = 1e8;

/** Compare la génération d'ondes (sparse) au pipeline dense de référence. */
export function comparerOndesVsDense(
  t: TenseurOnde,
  tailleSortie: number,
  modalite: "image" | "audio" | "video",
  seuil = 0.02,
): ComparaisonOndesDense {
  const sparse = compterActivationSparse(t, seuil);
  const opsOndes = sparse.actifs * tailleSortie;
  const opsDense =
    modalite === "audio"
      ? OPS_DENSE_REFERENCE_PAR_SECONDE_AUDIO
      : OPS_DENSE_REFERENCE_PAR_IMAGE;
  return {
    nbNoeuds: t.nbNoeuds,
    noeudsActifs: sparse.actifs,
    tailleSortie,
    opsOndes,
    opsDenseReference: opsDense,
    ratio: opsOndes > 0 ? opsDense / opsOndes : Infinity,
    methode: "ordre-de-grandeur-reference",
  };
}
