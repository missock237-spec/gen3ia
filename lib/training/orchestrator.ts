import "server-only";

import { newUlid } from "@/lib/storage/user-data-store";

import { findEngine, validatePlanAgainstEngine } from "./engines/registry";
import {
  getPlan,
  listActiveJobsForUser,
  listDatasets,
  getJob,
  saveJob,
} from "./repository";
import { assertJobConcurrency } from "./quotas";
import { JOB_EVENT_CAP, trainingJobSchema, type TrainingEvent, type TrainingJob, type TrainingPlan } from "./types";
import { providerSupportsVram, resolveProviders } from "./providers";
import type { GpuProvider, GpuProviderCapabilities } from "./providers";

/* ------------------------------------------------------------------ */
/* Orchestrateur des tâches d'entraînement (spec §7-D, §8)              */
/*                                                                    */
/* Machine à états explicite : chaque transition est validée avant     */
/* écriture. HONNÊTETÉ (règle 4) : sans fournisseur GPU disponible,     */
/* la tâche RESTE EN FILE avec `waitingReason` — jamais de progression  */
/* fictive, jamais de "completed" sans exécution réelle.               */
/*                                                                    */
/* Sweep opportuniste (pattern dispatch-loop du projet) : le listing    */
/* des jobs déclenche dispatch/rafraîchissement — aucune boucle         */
/* permanente n'est requise sur le VPS mono-process.                   */
/* ------------------------------------------------------------------ */

const JOB_TRANSITIONS: Record<TrainingJob["status"], TrainingJob["status"][]> = {
  queued: ["scheduled", "running", "cancelled", "failed"],
  scheduled: ["running", "cancelled", "failed", "queued"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
};

export function canTransition(from: TrainingJob["status"], to: TrainingJob["status"]): boolean {
  return JOB_TRANSITIONS[from]?.includes(to) ?? false;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeEvent(level: TrainingEvent["level"], message: string): TrainingEvent {
  return { at: nowIso(), level, message: message.slice(0, 1000) };
}

function withEvent(job: TrainingJob, event: TrainingEvent): TrainingJob {
  const events = [...job.events, event];
  // Rotation : les événements les plus anciens sont tronqués (doc < 256 Ko).
  return { ...job, events: events.slice(Math.max(0, events.length - JOB_EVENT_CAP)) };
}

/* ------------------------ Création depuis un plan ---------------- */

export interface CreateJobResult {
  job: TrainingJob;
}

/**
 * Crée une tâche à partir d'un plan accepté.
 * Vérifie : plan appartient à l'utilisateur, cohérence moteur, quota de
 * concurrence, présence d'un split d'entraînement (pour les méthodes qui
 * entraînent). Puis tente le dispatch immédiat.
 */
export async function createJobFromPlan(
  uid: string,
  plan: TrainingPlan,
): Promise<{ ok: true; job: TrainingJob } | { ok: false; error: string }> {
  const engine = findEngine(plan.engineId);
  if (!engine) return { ok: false, error: `Moteur inconnu : ${plan.engineId}.` };

  const planErrors = validatePlanAgainstEngine({
    method: plan.method,
    engineId: plan.engineId,
    parameters: plan.parameters,
  });
  if (planErrors.length > 0) return { ok: false, error: planErrors.join(" ") };

  const datasets = await listDatasets(uid, plan.projectId);
  if (plan.method !== "rag" && plan.method !== "eval-only") {
    const trainSplit = datasets.filter((d) => d.split === "train" && d.status === "valid");
    if (trainSplit.length === 0) {
      return {
        ok: false,
        error: "Aucun dataset valide assigné au split d'entraînement (train) : impossible de lancer l'entraînement.",
      };
    }
  }

  const active = await listActiveJobsForUser(uid);
  try {
    await assertJobConcurrency(uid, active.length);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Quota de concurrence atteint." };
  }

  const stamp = nowIso();
  let job = trainingJobSchema.parse({
    id: newUlid(),
    projectId: plan.projectId,
    planId: plan.id,
    ownerId: uid,
    status: "queued",
    progressPercent: null,
    epochsTotal: typeof plan.parameters.epochs === "number" ? plan.parameters.epochs : null,
    simulated: false,
    events: [],
    createdAt: stamp,
    updatedAt: stamp,
  });
  job = withEvent(job, makeEvent("info", `Tâche créée depuis le plan ${plan.id} (moteur ${engine.name}, méthode ${plan.method}).`));

  job = await dispatchJob(uid, job, plan);
  await saveJob(uid, job);
  return { ok: true, job };
}

/* ------------------------------ Dispatch -------------------------- */

async function selectProvider(
  minVramGb: number,
): Promise<{ provider: GpuProvider; capabilities: GpuProviderCapabilities } | null> {
  for (const provider of resolveProviders()) {
    try {
      const capabilities = await provider.capabilities();
      if (providerSupportsVram(capabilities, minVramGb)) {
        return { provider, capabilities };
      }
    } catch {
      // Fournisseur injoignable : on essaie le suivant (honnête, pas de repli simulé).
    }
  }
  return null;
}

/**
 * Tente de confier la tâche à un fournisseur GPU disponible.
 * Sans fournisseur : la tâche reste "queued" avec la raison d'attente.
 */
export async function dispatchJob(uid: string, job: TrainingJob, plan: TrainingPlan): Promise<TrainingJob> {
  if (job.status !== "queued") return job;
  const engine = findEngine(plan.engineId);
  if (!engine) {
    return withEvent(job, makeEvent("error", `Moteur ${plan.engineId} inconnu : tâche marquée en échec.`));
  }

  const selected = await selectProvider(engine.minVramGb);
  if (!selected) {
    const reason = "no-gpu-provider";
    const alreadyWaiting = job.waitingReason === reason;
    let updated: TrainingJob = {
      ...job,
      waitingReason: reason,
      updatedAt: nowIso(),
    };
    if (!alreadyWaiting) {
      updated = withEvent(
        updated,
        makeEvent(
          "warn",
          "Aucun fournisseur GPU disponible : la tâche reste en file d'attente. Configurez un worker GPU (TRAINING_WORKER_URL) pour l'exécuter réellement.",
        ),
      );
    }
    return updated;
  }

  const datasets = await listDatasets(uid, job.projectId);
  try {
    const { externalId } = await selected.provider.submit({
      jobId: job.id,
      engineId: plan.engineId,
      method: plan.method,
      parameters: plan.parameters,
      baseModel:
        plan.baseModelKind === "catalog"
          ? { kind: "catalog", ref: plan.baseModel }
          : { kind: "upload", ref: plan.baseModel, storageKey: undefined },
      datasets: datasets
        .filter((d) => d.status === "valid")
        .map((d) => ({ storageKey: d.storageKey, split: d.split, format: d.format })),
    });
    let updated: TrainingJob = {
      ...job,
      status: "running",
      providerId: selected.provider.id,
      externalJobId: externalId,
      simulated: selected.capabilities.simulated,
      waitingReason: null,
      startedAt: job.startedAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    updated = withEvent(
      updated,
      makeEvent(
        "info",
        selected.capabilities.simulated
          ? "[SIMULATION] Fournisseur simulé sélectionné — aucun entraînement réel ne sera exécuté."
          : `Tâche confiée au fournisseur ${selected.provider.label}.`,
      ),
    );
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    let updated: TrainingJob = { ...job, waitingReason: "submit-failed", updatedAt: nowIso() };
    updated = withEvent(updated, makeEvent("error", `Échec de soumission au fournisseur GPU : ${message}`));
    return updated;
  }
}

/* --------------------------- Rafraîchissement --------------------- */

/**
 * Rafraîchit une tâche en cours depuis son fournisseur.
 * Progression, perte, métriques : UNIQUEMENT ce que rapporte le fournisseur.
 */
export async function refreshJob(uid: string, job: TrainingJob): Promise<TrainingJob> {
  if (job.status !== "running" || !job.providerId || !job.externalJobId) return job;
  const provider = resolveProviders().find((p) => p.id === job.providerId);
  if (!provider) {
    return withEvent(
      { ...job, waitingReason: "provider-lost", updatedAt: nowIso() },
      makeEvent("warn", `Fournisseur ${job.providerId} disparu de la configuration : la tâche est orpheline. Relancez-la quand le fournisseur sera reconnecté.`),
    );
  }

  try {
    const state = await provider.status(job.externalJobId);
    let updated: TrainingJob = {
      ...job,
      progressPercent: state.progressPercent ?? job.progressPercent,
      currentStep: state.currentStep ?? job.currentStep,
      epochsDone: state.epochsDone ?? job.epochsDone,
      epochsTotal: state.epochsTotal ?? job.epochsTotal,
      trainLoss: state.trainLoss ?? job.trainLoss,
      metrics: { ...job.metrics, ...state.metrics },
      updatedAt: nowIso(),
    };

    // Journaux : ajout des lignes non encore enregistrées (dédupliquées par message).
    const seen = new Set(updated.events.map((e) => e.message));
    for (const line of state.logs) {
      if (!seen.has(line.message)) {
        updated = withEvent(updated, { at: line.at, level: line.level, message: line.message });
        seen.add(line.message);
      }
    }

    if (state.status === "completed") {
      updated = {
        ...updated,
        status: "completed",
        progressPercent: state.progressPercent ?? 100,
        finishedAt: nowIso(),
        artifacts: state.artifacts.map((a) => ({
          label: a.label ?? "",
          storageKey: a.storageKey,
          sizeBytes: a.sizeBytes ?? 0,
        })),
      };
      updated = withEvent(updated, makeEvent("info", "Tâche terminée : artefacts enregistrés, prêts pour l'évaluation."));
    } else if (state.status === "failed") {
      updated = {
        ...updated,
        status: "failed",
        finishedAt: nowIso(),
        error: state.error ?? "Échec rapporté par le fournisseur GPU.",
      };
      updated = withEvent(updated, makeEvent("error", updated.error ?? "Échec du fournisseur GPU."));
    }
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    return withEvent(job, makeEvent("warn", `Rafraîchissement impossible (${message}) : nouvelle tentative au prochain passage.`));
  }
}

/* ------------------------------ Annulation ------------------------ */

export async function cancelJob(uid: string, projectId: string, jobId: string): Promise<TrainingJob | null> {
  const job = await getJob(uid, projectId, jobId);
  if (!job) return null;
  if (!canTransition(job.status, "cancelled")) {
    throw new Error(`La tâche ne peut pas être annulée depuis l'état « ${job.status} ».`);
  }
  let updated: TrainingJob = {
    ...job,
    status: "cancelled",
    finishedAt: nowIso(),
    updatedAt: nowIso(),
  };
  if (job.providerId && job.externalJobId) {
    const provider = resolveProviders().find((p) => p.id === job.providerId);
    if (provider) {
      try {
        await provider.cancel(job.externalJobId);
        updated = withEvent(updated, makeEvent("info", "Annulation propagée au fournisseur GPU."));
      } catch {
        updated = withEvent(updated, makeEvent("warn", "Le fournisseur GPU n'a pas confirmé l'annulation : vérifiez ses journaux."));
      }
    }
  }
  updated = withEvent(updated, makeEvent("info", "Tâche annulée par l'utilisateur."));
  await saveJob(uid, updated);
  return updated;
}

/* ------------------------------ Sweep ----------------------------- */

/**
 * Balayage opportuniste des tâches actives d'un utilisateur :
 * dispatch des tâches en attente, rafraîchissement des tâches en cours.
 * Appelé par les routes de listing (pattern dispatch-loop).
 */
export async function sweepUserJobs(uid: string): Promise<{ dispatched: number; refreshed: number }> {
  let dispatched = 0;
  let refreshed = 0;
  const active = await listActiveJobsForUser(uid);
  for (const job of active.slice(0, 10)) {
    try {
      if (job.status === "queued") {
        const plan = await getPlan(uid, job.projectId, job.planId);
        if (!plan) {
          const failed = withEvent(
            { ...job, status: "failed", finishedAt: nowIso(), error: "Plan introuvable.", updatedAt: nowIso() },
            makeEvent("error", "Plan d'entraînement introuvable : tâche marquée en échec."),
          );
          await saveJob(uid, failed);
          continue;
        }
        const next = await dispatchJob(uid, job, plan);
        if (next.status !== job.status || next.updatedAt !== job.updatedAt) {
          dispatched++;
          await saveJob(uid, next);
        }
      } else if (job.status === "running") {
        const next = await refreshJob(uid, job);
        if (next.updatedAt !== job.updatedAt || next.status !== job.status) {
          refreshed++;
          await saveJob(uid, next);
        }
      }
    } catch {
      // Une tâche en erreur ne doit pas interrompre le balayage des autres.
    }
  }
  return { dispatched, refreshed };
}
