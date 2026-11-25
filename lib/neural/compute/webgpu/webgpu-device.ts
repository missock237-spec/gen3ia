/**
 * WEBGPU DEVICE — initialisation RÉELLE et unique (mission Phase 2-B et 3) :
 * requestAdapter() → requestDevice() → listeners de perte → reprise.
 * La disponibilité ne se limite PAS à navigator.gpu : un device fonctionnel
 * est exigé avant tout usage (« device-pret »). Environnements sans WebGPU :
 * statut « indisponible » avec raison honnête — jamais de fiction.
 *
 * Ce gestionnaire est la source UNIQUE du device : les moteurs du domaine
 * (ondes, RPIA, média) pourront s'y raccorder au lieu d'ouvrir chacun le
 * leur (découverte mission : N fabriques = N devices indépendants).
 */

import type { ConfigDeviceUnifie, ErreurGpuClassifiee, EtatDevice } from "./webgpu-types";

const globalDevice = globalThis as typeof globalThis & {
  __gen3iaGpuDevice?: { device: GPUDevice; etat: EtatDevice };
};

/** État honnête du device (sans ouverture — observation/dashboard). */
export function etatDeviceActuel(): EtatDevice {
  const present = globalDevice.__gen3iaGpuDevice;
  return present ? { ...present.etat } : { statut: "non-demande", pertes: 0 };
}

/**
 * Obtient le device partagé (initialisation unique). Ne lève pas :
 * indisponible → EtatDevice avec raison explicite.
 */
export async function obtenirDevicePartage(options: ConfigDeviceUnifie = {}): Promise<{ device?: GPUDevice; etat: EtatDevice }> {
  const existant = globalDevice.__gen3iaGpuDevice;
  if (existant && existant.etat.statut === "device-pret") {
    return { device: existant.device, etat: { ...existant.etat } };
  }

  if (typeof navigator === "undefined" || !(navigator as Navigator & { gpu?: GPU }).gpu) {
    return {
      etat: {
        statut: "indisponible",
        raison: "navigator.gpu absent de cet environnement (Node/serveur ou navigateur sans WebGPU)",
        pertes: 0,
      },
    };
  }

  try {
    const adaptateur = await navigator.gpu.requestAdapter({ powerPreference: options.powerPreference ?? "high-performance" });
    if (!adaptateur) {
      return { etat: { statut: "indisponible", raison: "aucun adaptateur WebGPU accepté (pilote désactivé, VM sans GPU)", pertes: 0 } };
    }
    const device = await adaptateur.requestDevice();
    const limitsPartiels: Record<string, number> = {};
    try {
      const l = device.limits as unknown as Record<string, number>;
      for (const cle of ["maxBufferSize", "maxComputeInvocationsPerWorkgroup", "maxStorageBufferBindingSize"]) {
        if (typeof l[cle] === "number") limitsPartiels[cle] = l[cle];
      }
    } catch {
      // limites non exposées : laissons les champs absents (honnête).
    }
    const etat: EtatDevice = {
      statut: "device-pret",
      adaptateur: typeof (adaptateur as GPUAdapter & { info?: GPUAdapterInfo }).info?.vendor === "string"
        ? `${(adaptateur as GPUAdapter & { info?: GPUAdapterInfo }).info!.vendor}`
        : "adaptateur WebGPU",
      limitsPartiels,
      pertes: existant?.etat.pertes ?? 0,
    };
    globalDevice.__gen3iaGpuDevice = { device, etat };
    enregistrerPerte(device, etat);
    return { device, etat: { ...etat } };
  } catch (e) {
    return {
      etat: {
        statut: "indisponible",
        raison: `initialisation device échouée : ${e instanceof Error ? e.message : "erreur"}`,
        pertes: existant?.etat.pertes ?? 0,
      },
    };
  }
}

/** Écoute `uncapturederror` + `lost` — journalisation et statut « perdu ». */
function enregistrerPerte(device: GPUDevice, etat: EtatDevice): void {
  device.lost.then((info) => {
    etat.statut = "perdu";
    etat.raison = `device perdu : ${info.reason ?? "raison inconnue"}`;
    etat.pertes += 1;
    // Suppression du cache : la prochaine demande réinitialisera le device.
    if (globalDevice.__gen3iaGpuDevice?.device === device) delete globalDevice.__gen3iaGpuDevice;
  });
  device.addEventListener?.("uncapturederror", (evenement) => {
    etat.raison = `uncapturederror : ${(evenement as GPUUncapturedErrorEvent).error?.message ?? "erreur"}`;
  });
}

/** Libère volontairement le device partagé (nettoyage mission Phase 2-D). */
export function libererDevicePartage(): void {
  const present = globalDevice.__gen3iaGpuDevice;
  if (!present) return;
  try {
    present.device.destroy();
  } catch {
    // destroy peut être refusé si le device est déjà perdu — sans effet.
  }
  delete globalDevice.__gen3iaGpuDevice;
}

/** Réinitialise après une perte : nouvelle demande complète. */
export async function reinitialiserDevice(options: ConfigDeviceUnifie = {}): Promise<EtatDevice> {
  libererDevicePartage();
  const { etat } = await obtenirDevicePartage(options);
  return etat;
}

/** Erreurs collectées (ring borné — journaux mission Phase 10). */
const erreursRecentes: ErreurGpuClassifiee[] = [];
export function journaliserErreurGpu(err: ErreurGpuClassifiee): void {
  erreursRecentes.push(err);
  if (erreursRecentes.length > 50) erreursRecentes.shift();
}
export function erreursGpuRecentes(): readonly ErreurGpuClassifiee[] {
  return erreursRecentes;
}
