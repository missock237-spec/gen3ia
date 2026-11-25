/**
 * EXECUTION CONTEXT (UCE) — contexte normalisé d'une exécution de capacité.
 * Pose le deadline, le contexte outil équivalent et le budget de sortie.
 */

import "server-only";

import { executionRequestSchema, type CapabilityExecutionRequest } from "../core/capability-contract";

export interface ContexteExecutionUce {
  demande: CapabilityExecutionRequest;
  /** Deadline calculée (défault 60 s, plafond 120 s — mission §8). */
  deadlineMs: number;
  dateIso: string;
  /** Budget de sortie persisté (octets) — limites mission §8. */
  budgetSortieOctets: number;
}

/** Valide et borne une demande d'exécution (fail-closed à la frontière). */
export function construireContexte(demandeBrute: unknown): ContexteExecutionUce {
  const demande = executionRequestSchema.parse(demandeBrute);
  return {
    demande,
    deadlineMs: demande.deadlineMs ?? 60_000,
    dateIso: new Date().toISOString(),
    budgetSortieOctets: 256_000,
  };
}
