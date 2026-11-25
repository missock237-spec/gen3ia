/**
 * WEBGPU TYPES — contrats du moteur WebGPU unifié (mission Phase 3).
 * Aucune duplication des moteurs ondes : cette couche porte le cycle de
 * vie COMMUN (device, pipelines, buffers, mémoire, erreurs) ; les moteurs
 * du domaine (moteur-webgpu.ts, moteurs-webgpu.ts, entraineur) gardent
 * leurs shaders et leurs contrats métier.
 */

/** Statut du device unifié (honnête : « demandé » ≠ « obtenu »). */
export type StatutDevice = "non-demande" | "adapter-obtenu" | "device-pret" | "indisponible" | "perdu";

export interface ConfigDeviceUnifie {
  powerPreference?: GPUPowerPreference;
  /** Libellé du device (traçabilité des pertes dans les journaux). */
  etiquete?: string;
}

export interface EtatDevice {
  statut: StatutDevice;
  raison?: string;
  /** Informations déclarées par l'adaptateur obtenues (aucune invention). */
  adaptateur?: string;
  limitsPartiels?: Record<string, number>;
  /** true si le device a été perdu au moins une fois depuis sa création. */
  pertes: number;
}

/** Erreur GPU classifiée (mission Phase 10 — journaux + circuit breaker). */
export type TypeErreurGpu = "compilation-wgsl" | "execution" | "device-perdu" | "memoire" | "indisponible";

export interface ErreurGpuClassifiee {
  type: TypeErreurGpu;
  message: string;
  /** Contexte libre (pipeline, taille dispatch…). */
  contexte?: string;
  horodatage: number;
}
