import "server-only";

import type { GpuProvider } from "./types";
import { workerHttpProvider } from "./worker-http";
import { mockProvider, mockProviderAllowed } from "./mock";

/* ------------------------------------------------------------------ */
/* Résolution des fournisseurs GPU actifs (spec §8)                     */
/*                                                                    */
/* Seuls les fournisseurs EXPLICITEMENT configurés sont retournés.      */
/* Par défaut (aucune variable) : liste vide → les tâches restent      */
/* en file d'attente avec un message honnête, AUCUNE simulation.        */
/* ------------------------------------------------------------------ */

export function resolveProviders(): GpuProvider[] {
  const providers: GpuProvider[] = [];
  if ((process.env.TRAINING_WORKER_URL ?? "").trim()) {
    providers.push(workerHttpProvider);
  }
  if (mockProviderAllowed()) {
    providers.push(mockProvider);
  }
  return providers;
}

export { workerHttpProvider, mockProvider, mockProviderAllowed };
export { providerSupportsVram } from "./types";
export type { GpuProvider, GpuProviderCapabilities, ProviderJobState, SubmitJobPayload, GpuInfo } from "./types";
