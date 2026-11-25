/**
 * PONT LEGACY (UCE V1.1 Phase 3) — l'unique entrée AUTORISÉE pour les
 * appelants historiques (moteurs conversationnels, route API, exécuteur
 * sécurisé agents) vers les outils natifs. Il construit une demande UCE
 * normalisée et délègue au Universal Execution Gateway : sémantique
 * d'exécution IDENTIQUE à `executeTool` ({success, output?, error?}, jamais
 * lève) mais avec les contrôles centraux complets (activation registre
 * central, autorisations unifiées, enregistrement cap_executions,
 * vérification indépendante, usage mesuré).
 *
 * `executeTool` reste l'adaptateur interne délégué (aucun remplacement) —
 * la garde automatique (`gateway-monopole.test.ts`) interdit tout appelant
 * externe de le contourner.
 */

import "server-only";

import type { ExecutionPolicy } from "@/lib/security/execution-policy";
import { executerCapacite, type OptionsGateway } from "./universal-gateway";

export interface DemandeOutilLegacy {
  userId: string;
  executionId: string;
  projectId?: string;
  toolName: string;
  input: unknown;
  /** Accepté pour compatibilité — transmis au chemin natif (abort réel). */
  signal?: AbortSignal;
  /** Politique d'exécution de la surface appelante (permissions fines). */
  policy?: ExecutionPolicy;
  /** Surface appelante tracée (conversation, api, agent, workflow…). */
  origine?: string;
  // ---- contexte normalisé V1.1 ----
  agentId?: string;
  sessionId?: string;
  traceId?: string;
}

/** Résultat identique au contrat historique de `executeTool`. */
export interface ResultatOutilLegacy {
  success: boolean;
  output?: unknown;
  error?: string;
}

const DEADLINE_MIN_MS = 1_000;
const DEADLINE_MAX_MS = 600_000;

/**
 * Exécute un outil natif VIA le Universal Execution Gateway. Ne lève jamais :
 * tout échec devient { success: false, error } — comportement historique
 * préservé, traçabilité UCE ajoutée.
 */
export async function executerOutilViaGateway(
  demande: DemandeOutilLegacy,
  options: OptionsGateway = {},
): Promise<ResultatOutilLegacy> {
  const policyDeadline = demande.policy?.maxToolExecutionMs;
  const deadlineMs = Math.min(
    Math.max(typeof policyDeadline === "number" ? policyDeadline : DEADLINE_MAX_MS, DEADLINE_MIN_MS),
    DEADLINE_MAX_MS,
  );

  const resultat = await executerCapacite(
    {
      executionId: demande.executionId,
      userId: demande.userId,
      projectId: demande.projectId,
      capabilityId: `natif:gen3ia:${demande.toolName}`,
      input: { toolName: demande.toolName, input: demande.input ?? {}, policy: demande.policy },
      origine: (demande.origine ?? "legacy").slice(0, 60),
      deadlineMs,
      agentId: demande.agentId,
      sessionId: demande.sessionId,
      traceId: demande.traceId,
    },
    { ...options, signal: options.signal ?? demande.signal },
  );

  return {
    success: resultat.execution.status === "succes",
    output: resultat.sortie,
    error: resultat.execution.erreur ?? undefined,
  };
}
