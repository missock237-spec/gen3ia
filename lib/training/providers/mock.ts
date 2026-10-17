import "server-only";

import type {
  GpuProvider,
  GpuProviderCapabilities,
  ProviderJobState,
  SubmitJobPayload,
} from "./types";

/* ------------------------------------------------------------------ */
/* Fournisseur MOCK — tests et développement UNIQUEMENT                 */
/*                                                                    */
/* Garde-fous (spec §13/§17 règle 4) :                                 */
/*  - TRAINING_ALLOW_MOCK doit valoir "true" explicitement ;            */
/*  - NODE_ENV doit être différent de "production" ;                    */
/*  - toute tâche issue du mock porte `simulated: true` et chaque       */
/*    événement est préfixé "[SIMULATION]" — une simulation ne peut     */
/*    JAMAIS être confondue avec un entraînement réel.                 */
/* ------------------------------------------------------------------ */

interface MockJob {
  payload: SubmitJobPayload;
  startedAt: number;
  progress: number;
}

const jobs = new Map<string, MockJob>();

export function mockProviderAllowed(): boolean {
  return process.env.TRAINING_ALLOW_MOCK === "true" && process.env.NODE_ENV !== "production";
}

const TICK_MS = 200;

/** Durée d'une étape simulée — configurable pour les tests (TRAINING_MOCK_STEP_MS). */
function stepMs(): number {
  const parsed = Number.parseInt(process.env.TRAINING_MOCK_STEP_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1_500;
}

function advance(job: MockJob): ProviderJobState {
  const elapsed = Date.now() - job.startedAt;
  const progress = Math.min(100, Math.floor((elapsed / (stepMs() * 10)) * 10));
  job.progress = progress;
  const epochsTotal = typeof job.payload.parameters.epochs === "number" ? job.payload.parameters.epochs : 3;
  const logs: ProviderJobState["logs"] = [
    {
      at: new Date(job.startedAt).toISOString(),
      level: "info",
      message: "[SIMULATION] Démarrage du cycle simulé — AUCUN entraînement réel n'est exécuté.",
    },
  ];
  if (progress >= 50) {
    logs.push({
      at: new Date(job.startedAt + elapsed / 2).toISOString(),
      level: "info",
      message: `[SIMULATION] Étape fictive ${Math.floor(progress / 10)}/10 (perte simulée ${(2.0 - progress / 71).toFixed(3)}).`,
    });
  }
  if (progress >= 100) {
    logs.push({
      at: new Date().toISOString(),
      level: "info",
      message: "[SIMULATION] Cycle simulé terminé — aucun poids n'a été produit.",
    });
  }
  return {
    externalId: "",
    status: progress >= 100 ? "completed" : "running",
    progressPercent: progress,
    currentStep: "[SIMULATION] pas de simulation",
    epochsDone: Math.min(epochsTotal, Math.floor((progress / 100) * epochsTotal)),
    epochsTotal,
    trainLoss: progress >= 100 ? 0.42 : 2.0 - (progress / 100) * 1.5,
    metrics: {},
    logs,
    error: null,
    artifacts: [],
  };
}

export const mockProvider: GpuProvider = {
  id: "mock",
  label: "Simulation (tests uniquement)",

  async capabilities(): Promise<GpuProviderCapabilities> {
    if (!mockProviderAllowed()) {
      return {
        providerId: "mock",
        label: "Simulation (tests uniquement)",
        gpus: [],
        maxDurationMinutes: null,
        simulated: true,
      };
    }
    return {
      providerId: "mock",
      label: "Simulation (tests uniquement)",
      gpus: [{ name: "GPU simulé", vramGb: 24, available: true }],
      maxDurationMinutes: 5,
      simulated: true,
    };
  },

  async submit(payload: SubmitJobPayload): Promise<{ externalId: string }> {
    if (!mockProviderAllowed()) {
      throw new Error("Fournisseur mock désactivé : activez TRAINING_ALLOW_MOCK=true hors production.");
    }
    const externalId = `sim-${Math.random().toString(36).slice(2, 10)}`;
    jobs.set(externalId, { payload, startedAt: Date.now(), progress: 0 });
    // Pré-avance minimale pour que la première sonde ne soit pas vide.
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
    return { externalId };
  },

  async status(externalId: string): Promise<ProviderJobState> {
    const job = jobs.get(externalId);
    if (!job) throw new Error("Tâche simulée inconnue (expirée après redémarrage du process de test).");
    return { ...advance(job), externalId };
  },

  async cancel(externalId: string): Promise<void> {
    jobs.delete(externalId);
  },
};
