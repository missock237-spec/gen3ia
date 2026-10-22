/**
 * Fabrique du moteur d'ondes : tente WebGPU (le GPU de l'utilisateur
 * résout la grille d'ondes en compute shaders) et retombe proprement
 * sur le moteur CPU universel — la visualisation fonctionne partout,
 * seule la vélocité de propagation change.
 *
 * SWARM-EDGE HARDWARE COMPILER : quand `compilerHardware` est actif,
 * l'Agent Master sonde d'abord le GPU (vendor, architecture, limites),
 * classe son profil (Apple Metal / Vulkan / DirectX 12 / inconnu) puis
 * compile un WGSL ULTRA-OPTIMISÉ pour CETTE architecture (workgroup
 * calibré, constantes fondues, épilogue spécialisé). La moindre
 * hésitation retombe sur le shader standard — l'optimisation ne casse
 * jamais le champ.
 */

import { MoteurCpu, type MoteurOndes } from "./champ";
import { MoteurWebGPU } from "./moteur-webgpu";
import { classerProfil, compilerWGSL, sonderMateriel, type ProfilGPU, type ShaderSpecialise } from "./compilateur-hardware";
import type { ConfigOndes } from "./types";

export interface ResultatFabrique {
  moteur: MoteurOndes;
  type: "webgpu" | "cpu";
  /** Raison du repli CPU (affichée en badge dans le laboratoire). */
  raison?: string;
  /** Profil matériel sondé (si compilation matérielle demandée). */
  profil?: ProfilGPU;
  /** Shader spécialisé compilé (si compilation matérielle réussie). */
  shader?: ShaderSpecialise;
}

export function webgpuDisponible(): boolean {
  try {
    return typeof navigator !== "undefined" && typeof navigator.gpu !== "undefined";
  } catch {
    return false;
  }
}

export interface OptionsFabrique {
  /**
   * Sonde le GPU et compile un shader spécialisé (Swarm-Edge Hardware
   * Compiler). Défaut : true — le repli vers le shader standard est
   * automatique en cas de moindre doute.
   */
  compilerHardware?: boolean;
}

export async function creerMoteur(cfg: ConfigOndes, options?: OptionsFabrique): Promise<ResultatFabrique> {
  const compilerHardware = options?.compilerHardware ?? true;
  if (webgpuDisponible()) {
    let profil: ProfilGPU | undefined;
    let shader: ShaderSpecialise | undefined;
    if (compilerHardware) {
      try {
        const sonde = await sonderMateriel();
        profil = classerProfil(sonde);
        shader = compilerWGSL(profil, cfg);
      } catch {
        // Sondage impossible : shader standard, aucune conséquence.
        profil = undefined;
        shader = undefined;
      }
    }
    try {
      const moteur = await MoteurWebGPU.creer(cfg, shader ? { code: shader.code, workgroup: shader.workgroup } : undefined);
      return { moteur, type: "webgpu", ...(profil && shader ? { profil, shader } : {}) };
    } catch (erreur) {
      return {
        moteur: new MoteurCpu(cfg),
        type: "cpu",
        raison:
          erreur instanceof Error
            ? `WebGPU refusé (${erreur.message}) — moteur CPU actif`
            : "WebGPU refusé — moteur CPU actif",
        ...(profil && shader ? { profil, shader } : {}),
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
  options?: OptionsFabrique,
): Promise<MoteurOndes> {
  const freq = ancien.frequences();
  ancien.detruire();
  const resultat = await creerMoteur(cfg, options);
  resultat.moteur.remplacerFrequences(freq.subarray(0, Math.min(freq.length, resultat.moteur.largeur * resultat.moteur.hauteur)));
  return resultat.moteur;
}
