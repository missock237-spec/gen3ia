/**
 * WEBGPU ERROR HANDLER — classification des erreurs GPU (mission Phase 3-7
 * et 10) : compilation WGSL, exécution, perte de device, mémoire,
 * indisponibilité. Alimente le circuit breaker (compute-security) et le
 * dashboard. Aucune erreur avalée : chacune est classée et journalisée.
 */

import { journaliserErreurGpu } from "./webgpu-device";
import type { ErreurGpuClassifiee, TypeErreurGpu } from "./webgpu-types";

/** Classifie une erreur inconnue selon son message (sans invention de cause). */
export function classifierErreur(erreur: unknown, contexte?: string): ErreurGpuClassifiee {
  const message = erreur instanceof Error ? erreur.message : String(erreur);
  const m = message.toLowerCase();
  let type: TypeErreurGpu = "execution";
  if (m.includes("device perdu") || m.includes("device lost") || m.includes("perdu")) type = "device-perdu";
  else if (m.includes("wgsl") || m.includes("shader") || m.includes("compilation") || m.includes("naga")) type = "compilation-wgsl";
  else if (m.includes("out of memory") || m.includes("mémoire") || m.includes("buffer")) type = "memoire";
  else if (m.includes("indisponible") || m.includes("navigator.gpu")) type = "indisponible";
  const classifiee: ErreurGpuClassifiee = { type, message, contexte, horodatage: Date.now() };
  journaliserErreurGpu(classifiee);
  return classifiee;
}

/** Capture les erreurs de COMPILATION d'un module shader (getCompilationInfo). */
export async function verifierCompilation(module: GPUShaderModule, contexte?: string): Promise<ErreurGpuClassifiee[]> {
  try {
    const infos = await module.getCompilationInfo();
    return infos.messages
      .filter((msg) => msg.type === "error")
      .map((msg) => {
        const e: ErreurGpuClassifiee = {
          type: "compilation-wgsl",
          message: `${msg.message} (ligne ${msg.lineNum})`,
          contexte,
          horodatage: Date.now(),
        };
        journaliserErreurGpu(e);
        return e;
      });
  } catch (e) {
    return [classifierErreur(e, contexte ?? "getCompilationInfo indisponible")];
  }
}
