import type { RunStep, RunStepStatus } from "@/lib/domain/conversations/types";

/**
 * Estimation du temps de livraison d'une mission (étape 9 du plan 20).
 *
 * Principe d'HONNÊTETÉ : l'estimation est calculée depuis des durées RÉELLES
 * mesurées sur les étapes déjà terminées du run (apprentissage par mission),
 * complétées par des durées typiques par phase pour les étapes restantes.
 * Les étapes « awaiting » (validation humaine) sont EXCLUES de l'estimation
 * machine — on ne peut pas prédire quand l'utilisateur confirmera : l'UI
 * l'annonce explicitement plutôt que de mentir.
 *
 * Pur et déterministe étant donné (steps, now) — testable exhaustivement.
 */

/** Durées typiques par phase (ms) — calibrées sur les tours conversationnels. */
export const TYPICAL_PHASE_MS: Record<string, number> = {
  understanding: 8_000,
  plan: 12_000,
  tools: 10_000,
  approval: 0, // attente humaine : jamais estimée
  execution: 30_000,
  result: 6_000,
};
const CLOCK_TICK_MIN_MS = 1_000;

export interface RunEta {
  /** Temps restant estimé (ms). 0 si tout est terminé. */
  remainingMs: number;
  /** Heure de livraison estimée (epoch ms) — now + remaining. */
  estimatedDeliveryAt: number;
  /** Base de l'estimation : mesures réelles ou durées typiques. */
  basis: "measured" | "typical" | "none";
  /** Étapes terminées / total (hors annulées). */
  completedCount: number;
  totalSteps: number;
  /** Nombre d'étapes en attente de validation humaine (exclues de l'ETA). */
  awaitingCount: number;
}

function stepDurationMs(step: RunStep): number | undefined {
  if (!step.startedAt || !step.finishedAt) return undefined;
  const start = Date.parse(step.startedAt);
  const end = Date.parse(step.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] as number + sorted[middle] as number) / 2) : sorted[middle] as number;
}

/** Durée typique mesurée pour la phase (médiane des étapes terminées). */
function measuredPhaseMs(steps: RunStep[], phase: string): number | undefined {
  const durations = steps
    .filter((step) => step.phase === phase && step.status === "done")
    .map(stepDurationMs)
    .filter((value): value is number => value !== undefined && value > 0);
  return durations.length > 0 ? median(durations) : undefined;
}

function estimatedStepCost(step: RunStep, steps: RunStep[]): number {
  const measured = measuredPhaseMs(steps, step.phase);
  const typical = TYPICAL_PHASE_MS[step.phase] ?? TYPICAL_PHASE_MS.execution;
  // La mesure réelle prime sur la valeur typique (représentativité par run).
  return measured ?? typical;
}

/**
 * Estime le temps restant avant la livraison de la mission.
 *  - étapes done/failed : ignorées ;
 *  - étape in_progress : coût estimé − temps déjà écoulé (≥ 0) ;
 *  - étapes awaiting : EXCLUES (attente humaine, comptabilisées à part) ;
 *  - étapes pending : coût estimé (mesuré si dispo, sinon typique).
 */
export function estimateRunEta(steps: RunStep[], now: number = Date.now()): RunEta {
  const active = steps.filter((step) => step.status !== "skipped");
  const completedCount = active.filter((step) => step.status === "done" || step.status === "failed").length;
  const awaitingCount = active.filter((step) => step.status === "awaiting").length;

  if (active.length === 0 || completedCount === active.length) {
    return { remainingMs: 0, estimatedDeliveryAt: now, basis: "none", completedCount, totalSteps: active.length, awaitingCount };
  }

  const measuredAvailable = active.some((step) => step.status === "done" && stepDurationMs(step) !== undefined);

  let remainingMs = 0;
  for (const step of active) {
    if (step.status === "done" || step.status === "failed") continue;
    if (step.status === "awaiting") continue; // validation humaine : hors estimation
    const cost = estimatedStepCost(step, steps);
    if (step.status === "in_progress" && step.startedAt) {
      const startedAt = Date.parse(step.startedAt);
      if (Number.isFinite(startedAt)) {
        const elapsed = Math.max(0, now - startedAt);
        remainingMs += Math.max(CLOCK_TICK_MIN_MS, cost - elapsed);
        continue;
      }
    }
    remainingMs += cost;
  }

  return {
    remainingMs,
    estimatedDeliveryAt: now + remainingMs,
    basis: measuredAvailable ? "measured" : "typical",
    completedCount,
    totalSteps: active.length,
    awaitingCount,
  };
}

/**
 * Formatage lisible et HONNÊTE de l'ETA :
 *  - « Livraison estimée dans moins d'une minute » ;
 *  - « Livraison estimée dans ~2 min (14:32) » ;
 *  - mention explicite des validations humaines en attente ;
 *  - chaîne vide quand il n'y a plus rien à estimer.
 */
export function formatRunEta(eta: RunEta, now: number = Date.now()): string {
  if (eta.totalSteps === 0 || (eta.remainingMs === 0 && eta.awaitingCount === 0)) return "";
  // Horloge d'affichage potentiellement en retard sur l'estimation : la
  // livraison affichée ne peut jamais être déjà passée.
  const deliveryAt = Math.max(eta.estimatedDeliveryAt, now + CLOCK_TICK_MIN_MS);
  const minutes = Math.max(1, Math.round(eta.remainingMs / 60_000));
  let timePart: string;
  if (eta.remainingMs <= 60_000) {
    timePart = "moins d'une minute";
  } else if (minutes <= 30) {
    const delivery = new Date(deliveryAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    timePart = `~${minutes} min (${delivery})`;
  } else {
    const delivery = new Date(deliveryAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    timePart = `plus de 30 min (${delivery})`;
  }
  const awaitingPart = eta.awaitingCount > 0
    ? ` — hors ${eta.awaitingCount} validation${eta.awaitingCount > 1 ? "s" : ""} en attente de votre accord`
    : "";
  return `Livraison estimée dans ${timePart}${awaitingPart}`;
}

/** Statuts considérés comme « en cours » pour l'affichage de l'ETA. */
export function isRunActive(status: string): boolean {
  return status === "running" || status === "paused";
}

/** Type utilitaire exposé pour les tests de statut. */
export type EtaStepStatus = RunStepStatus;
