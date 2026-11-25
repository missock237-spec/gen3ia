/**
 * HARDWARE DETECTOR — détection HONNÊTE des capacités matérielles
 * (mission Phase 2). Répond uniquement ce qui est vérifiable :
 *  - Node/serveur : WebGPU indisponible (raison explicite) — le CPU
 *    reste toujours disponible ;
 *  - navigateur : sonde navigator.gpu → adaptateur → limites/features
 *    (même protocole que lib/neural/webgpu/detect.ts, sans l'annoter
 *    "use client" pour rester testable côté Node).
 *
 * Règle : jamais de capacité inventée — une sonde échouée = indisponible.
 */

import type { CapacitesMateriel } from "./compute-types";

let cache: CapacitesMateriel | null = null;

/** Environnement Node/serveur : pas de WebGPU — CPU seul, honnêteté. */
function capacitesNode(): CapacitesMateriel {
  return {
    webgpuDisponible: false,
    raisonIndisponibilite: "WebGPU absent de cet environnement (Node/serveur — API navigateur uniquement)",
    environnement: process.env.NEXT_RUNTIME === "edge" ? "serveur" : "node",
  };
}

/** Sonde navigateur : adaptateur réel, limites et features déclarées. */
async function sonderNavigateur(): Promise<CapacitesMateriel> {
  const resultat: CapacitesMateriel = { webgpuDisponible: false, environnement: "navigateur" };
  try {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) {
      resultat.raisonIndisponibilite = "navigator.gpu absent de ce navigateur (Chrome/Edge 113+, Safari 18+, Firefox 141+)";
      return resultat;
    }
    const adaptateur = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adaptateur) {
      resultat.raisonIndisponibilite = "aucun adaptateur GPU WebGPU (pilote désactivé, VM sans GPU)";
      return resultat;
    }
    const limits = adaptateur.limits as GPUSupportedLimits & { maxBufferSize?: number };
    resultat.webgpuDisponible = true;
    resultat.maxBufferSizeOctets = limits.maxBufferSize;
    resultat.familleGpu = "adapteur-webgpu";
    try {
      const info = (adaptateur as GPUAdapter & { info?: GPUAdapterInfo }).info;
      resultat.adaptateur = info?.vendor ? `${info.vendor} ${info.architecture ?? ""}`.trim() : "adaptateur WebGPU";
    } catch {
      resultat.adaptateur = "adaptateur WebGPU";
    }
  } catch (e) {
    resultat.raisonIndisponibilite = `sonde échouée : ${e instanceof Error ? e.message : "erreur"}`;
  }
  return resultat;
}

/**
 * Détecte les capacités RÉELLES (cache module — la capacité ne change pas
 * en vol ; le device lui-même est ouvert/fermé par le moteur unifié).
 */
export async function detecterCapacites(): Promise<CapacitesMateriel> {
  if (cache) return cache;
  let cap: CapacitesMateriel;
  if (typeof navigator === "undefined" || typeof (navigator as Navigator & { gpu?: GPU }).gpu === "undefined") {
    cap = capacitesNode();
  } else {
    cap = await sonderNavigateur();
  }
  cache = cap;
  return cap;
}

/** Réinitialise la sonde (tests). */
export function reinitialiserDetection(): void {
  cache = null;
}

/** Cap CPU — toujours disponible (mission : jamais de tâche perdue). */
export function cpuDisponible(): boolean {
  return true;
}
