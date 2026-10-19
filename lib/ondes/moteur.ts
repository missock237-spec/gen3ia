/**
 * Fabrique du moteur d'ondes : tente WebGPU (le GPU de l'utilisateur
 * résout la grille d'ondes en compute shaders) et retombe proprement
 * sur le moteur CPU universel — la visualisation fonctionne partout,
 * seule la vélocité de propagation change.
 */

import { MoteurCpu, type MoteurOndes } from "./champ";
import { MoteurWebGPU } from "./moteur-webgpu";
import type { ConfigOndes } from "./types";

export interface ResultatFabrique {
  moteur: MoteurOndes;
  type: "webgpu" | "cpu";
  /** Raison du repli CPU (affichée en badge dans le laboratoire). */
  raison?: string;
}

export function webgpuDisponible(): boolean {
  try {
    return typeof navigator !== "undefined" && typeof navigator.gpu !== "undefined";
  } catch {
    return false;
  }
}

export async function creerMoteur(cfg: ConfigOndes): Promise<ResultatFabrique> {
  if (webgpuDisponible()) {
    try {
      const moteur = await MoteurWebGPU.creer(cfg);
      return { moteur, type: "webgpu" };
    } catch (erreur) {
      return {
        moteur: new MoteurCpu(cfg),
        type: "cpu",
        raison:
          erreur instanceof Error
            ? `WebGPU refusé (${erreur.message}) — moteur CPU actif`
            : "WebGPU refusé — moteur CPU actif",
      };
    }
  }
  return {
    moteur: new MoteurCpu(cfg),
    type: "cpu",
    raison: "Navigateur sans WebGPU — moteur CPU actif",
  };
}

/**
 * Reconstruit un moteur pour une nouvelle configuration (changement
 * d'effort) en conservant la carte de fréquences (l'évolution survit
 * au changement de résolution).
 */
export async function reconfigurerMoteur(
  ancien: MoteurOndes,
  cfg: ConfigOndes,
): Promise<MoteurOndes> {
  const freq = ancien.frequences();
  ancien.detruire();
  const resultat = await creerMoteur(cfg);
  resultat.moteur.remplacerFrequences(freq.subarray(0, Math.min(freq.length, resultat.moteur.largeur * resultat.moteur.hauteur)));
  return resultat.moteur;
}
