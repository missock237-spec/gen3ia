/**
 * WEBGPU ENGINE — façade UNIFIÉE du moteur GPU (mission Phase 3) : un seul
 * point d'entrée pour device partagé, pipelines en cache, buffers en pool,
 * budget mémoire et dispatch. Les moteurs du domaine (ondes, RPIA, média)
 * s'y raccordent au lieu d'ouvrir chacun leur device — sans changer leurs
 * contrats métier ni leurs shaders.
 */

import { obtenirDevicePartage, libererDevicePartage, reinitialiserDevice } from "./webgpu-device";
import { obtenirPipeline, viderPipelines } from "./webgpu-pipeline";
import { obtenirBuffer, rendreBuffer, viderPools, type BufferAlloue } from "./webgpu-buffer-pool";
import { reserverMemoireGpu, libererMemoireGpu, etatMemoireGpu } from "./webgpu-memory-manager";
import { classifierErreur } from "./webgpu-error-handler";

export interface DescripteurCompute {
  /** Code WGSL (mis en cache par pipeline). */
  code: string;
  entryPoint?: string;
  /** Octets à réserver pour l'exécution (contrôle budget avant dispatch). */
  octetsRequis: number;
}

export interface SessionComputeGpu {
  device: GPUDevice;
  pipeline: GPUComputePipeline;
  /** Buffers prêtés par le pool (à rendre après usage). */
  buffer: (taille: number) => BufferAlloue;
  rendre: (b: BufferAlloue) => void;
  /** Dispatch d'un pass de calcul — exceptions classifiées et journalisées. */
  dispatch: (bindGroup: GPUBindGroup, groupesX: number, groupesY?: number, groupesZ?: number) => void;
  terminer: () => void;
}

export const MoteurWebGPUUnifie = {
  /**
   * Ouvre une session de calcul GPU : device partagé → pipeline en cache →
   * contrôle budget mémoire. Échec à tout niveau → raison classifiée (le
   * fallback CPU reste géré par compute-fallback, pas ici).
   */
  ouvrirSession: async (descripteur: DescripteurCompute): Promise<{ session?: SessionComputeGpu; erreur?: string; type?: string }> => {
    const { device, etat } = await obtenirDevicePartage();
    if (!device) {
      return { erreur: etat.raison ?? "device indisponible", type: "indisponible" };
    }
    const autorise = reserverMemoireGpu(descripteur.octetsRequis);
    if (!autorise.autorise) {
      return { erreur: autorise.raison, type: "memoire" };
    }
    const { pipeline, erreurs } = await obtenirPipeline(device, descripteur.code, descripteur.entryPoint ?? "principal");
    if (!pipeline) {
      libererMemoireGpu(descripteur.octetsRequis);
      return { erreur: erreurs?.join(" | ") ?? "compilation WGSL échouée", type: "compilation-wgsl" };
    }
    let encodeur: GPUCommandEncoder | null = null;
    let passe: GPUComputePassEncoder | null = null;
    const session: SessionComputeGpu = {
      device,
      pipeline,
      buffer: (taille: number) => obtenirBuffer(device, taille),
      rendre: (b: BufferAlloue) => rendreBuffer(b),
      dispatch: (bindGroup, gx, gy = 1, gz = 1) => {
        if (!encodeur) {
          encodeur = device.createCommandEncoder();
          passe = encodeur.beginComputePass();
          passe!.setPipeline(pipeline);
        }
        passe!.setBindGroup(0, bindGroup);
        passe!.dispatchWorkgroups(gx, gy, gz);
      },
      terminer: () => {
        try {
          if (encodeur && passe) {
            passe!.end();
            device.queue.submit([encodeur!.finish()]);
          }
        } finally {
          encodeur = null;
          passe = null;
          libererMemoireGpu(descripteur.octetsRequis);
        }
      },
    };
    return { session };
  },

  /** Ferme TOUT (device perdu confirmé, arrêt) : pools + pipelines + device. */
  fermerTout: (): void => {
    viderPools();
    viderPipelines();
    libererDevicePartage();
  },

  /** Réinitialise après perte : ferme tout puis redemande un device. */
  reinitialiser: async (): Promise<string> => {
    MoteurWebGPUUnifie.fermerTout();
    const etat = await reinitialiserDevice();
    return etat.raison ?? etat.statut;
  },

  /** Observation (dashboard) : mémoire GPU Gen3ia classifiée réelle. */
  memoire: etatMemoireGpu,

  /** Classifie une erreur brute (utilsation par compute-fallback/cereau). */
  classifie: classifierErreur,
};
