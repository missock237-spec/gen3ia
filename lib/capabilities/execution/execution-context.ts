/**
 * EXECUTION CONTEXT (UCE) — contexte normalisé d'une exécution de capacité.
 * Pose le deadline, le contexte outil équivalent et le budget de sortie.
 *
 * V1.1 (mission Phase 3) : le contexte porte le contrat normalisé complet —
 * executionId, capabilityId, userId, agentId, sessionId, input, permissions
 * (décidées pendant le cycle), approvalContext, resourceLimits, deadline,
 * traceId — sans casser la compatibilité V1 (champs optionnels).
 */

import "server-only";

import { executionRequestSchema, type CapabilityExecutionRequest } from "../core/capability-contract";

export interface ContexteExecutionUce {
  demande: CapabilityExecutionRequest;
  /** Deadline calculée (défault 60 s, plafond 600 s — politiques agents 300 s). */
  deadlineMs: number;
  dateIso: string;
  /** Budget de sortie persisté (octets) — limites mission §8. */
  budgetSortieOctets: number;
  /** Identifiant de traçabilité transversal (demande ou dérivé de l'exécution). */
  traceId: string;
  /** Signal d'annulation de la surface appelante (abort réel transmis). */
  signal?: AbortSignal;
}

/** Plafond de durée par défaut (aucune exécution sans borne). */
const DEADLINE_DEFAUT_MS = 60_000;
const DEADLINE_PLAFOND_MS = 600_000;

/** Valide et borne une demande d'exécution (fail-closed à la frontière). */
export function construireContexte(demandeBrute: unknown): ContexteExecutionUce {
  const demande = executionRequestSchema.parse(demandeBrute);
  const deadlineBrute = demande.deadlineMs ?? demande.resourceLimits?.maxDurationMs ?? DEADLINE_DEFAUT_MS;
  return {
    demande,
    deadlineMs: Math.min(Math.max(deadlineBrute, 1_000), DEADLINE_PLAFOND_MS),
    dateIso: new Date().toISOString(),
    budgetSortieOctets: demande.resourceLimits?.maxOutputBytes ?? 256_000,
    traceId: demande.traceId ?? `trace-${demande.executionId}`,
  };
}
