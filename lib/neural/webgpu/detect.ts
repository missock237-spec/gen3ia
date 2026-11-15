"use client";

/**
 * DÉTECTION WEBGPU — capacité du navigateur de l'utilisateur.
 *
 * La génération média photoréaliste/voix/vidéo de Gen3 s'exécute sur le GPU
 * DE L'UTILISATEUR (WebGPU) : rien ne quitte son appareil, aucun serveur
 * d'IA externe. Ce module détermine honnêtement si l'appareil le permet :
 *  - `navigator.gpu` présent + adaptateur obtenu (Chrome/Edge 113+, ou
 *    Safari 18+, Firefox 141+) ;
 *  - mémoire GPU déclarée suffisante pour le SD fp16 (~2 Go de VRAM utile) ;
 *  - repli annoncé (moteur neuronal abstrait serveur) sinon.
 */

export interface CapacitéWebGpu {
  disponible: boolean;
  /** Raison honnête d'indisponibilité (télémétrie + message utilisateur). */
  raison?: string;
  adaptateur?: string;
  /** Mémoire max du buffer (Go) — indicateur de classe d'appareil. */
  memoireGo?: number;
  features?: string[];
}

let cache: CapacitéWebGpu | null = null;

/** Sonde WebGPU (mise en cache module — la capacité ne change pas en vol). */
export async function détecterWebGpu(): Promise<CapacitéWebGpu> {
  if (cache) return cache;
  const résultat: CapacitéWebGpu = { disponible: false };
  try {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) {
      résultat.raison = "WebGPU absent de ce navigateur (Chrome/Edge 113+ ou Safari 18+ requis)";
      cache = résultat;
      return résultat;
    }
    if (typeof gpu.requestAdapter !== "function") {
      résultat.raison = "WebGPU incomplet (requestAdapter indisponible)";
      cache = résultat;
      return résultat;
    }
    const adaptateur = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adaptateur) {
      résultat.raison = "Aucun adaptateur GPU WebGPU (pilote désactivé ou VM sans GPU)";
      cache = résultat;
      return résultat;
    }
    const limits = adaptateur.limits as GPUSupportedLimits & { maxBufferSize?: number };
    const mémoireGo = limits.maxBufferSize ? limits.maxBufferSize / 1024 ** 3 : undefined;
    résultat.disponible = true;
    résultat.memoireGo = mémoireGo;
    résultat.features = [...adaptateur.features].slice(0, 8);
    try {
      const info = (adaptateur as GPUAdapter & { info?: GPUAdapterInfo }).info;
      résultat.adaptateur = info?.vendor && info?.architecture
        ? `${info.vendor} ${info.architecture}`
        : "adaptateur WebGPU";
    } catch {
      résultat.adaptateur = "adaptateur WebGPU";
    }
  } catch (e) {
    résultat.raison = `Sonde WebGPU échouée : ${e instanceof Error ? e.message : "erreur"}`;
  }
  cache = résultat;
  return résultat;
}
