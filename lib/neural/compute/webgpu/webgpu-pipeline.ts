/**
 * WEBGPU PIPELINE — cache des compute pipelines par code WGSL (mission
 * Phase 3-2) : un code = une compilation, plus jamais de recompilation
 * par pas de calcul. Les erreurs de compilation WGSL sont collectées via
 * getCompilationInfo (webgpu-error-handler) et bloquent le pipeline.
 */

import { verifierCompilation } from "./webgpu-error-handler";
import type { EtatDevice } from "./webgpu-types";

const globalPipelines = globalThis as typeof globalThis & {
  __gen3iaGpuPipelines?: Map<string, GPUComputePipeline>;
};

function cachePipelines(): Map<string, GPUComputePipeline> {
  if (!globalPipelines.__gen3iaGpuPipelines) globalPipelines.__gen3iaGpuPipelines = new Map();
  return globalPipelines.__gen3iaGpuPipelines;
}

/**
 * Obtient (ou compile et met en cache) un pipeline de calcul. Ne lève pas :
 * échec de compilation → { pipeline: undefined, erreurs } avec le détail.
 */
export async function obtenirPipeline(
  device: GPUDevice,
  code: string,
  entryPoint = "principal",
): Promise<{ pipeline?: GPUComputePipeline; erreurs?: string[] }> {
  const cle = `${entryPoint}:${code}`;
  const enCache = cachePipelines().get(cle);
  if (enCache) return { pipeline: enCache };

  const module_ = device.createShaderModule({ code });
  const erreursCompilation = await verifierCompilation(module_, "obtenirPipeline");
  if (erreursCompilation.length > 0) {
    return { erreurs: erreursCompilation.map((e) => e.message) };
  }
  try {
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module: module_, entryPoint } });
    cachePipelines().set(cle, pipeline);
    return { pipeline };
  } catch (e) {
    return { erreurs: [e instanceof Error ? e.message : "createComputePipeline échoué"] };
  }
}

/** Nombre de pipelines en cache (dashboard). */
export function statsPipelines(): number {
  return cachePipelines().size;
}

/** Purge (device perdu — les pipelines ne survivent pas au device). */
export function viderPipelines(): void {
  cachePipelines().clear();
}

/** État device raccourci pour l'engine (utilisé par webgpu-engine). */
export type EtatDeviceRaccourci = EtatDevice;
