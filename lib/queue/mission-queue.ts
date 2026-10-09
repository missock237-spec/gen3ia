import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";
import { runFirestoreGuarded } from "@/lib/queue/firestore-guard";
import type { RuntimePlan } from "@/lib/agents/runtime/types";
import type { OutcomeContract } from "@/lib/agents/outcome-contract";
import type { MissionDeliverable } from "@/lib/agents/deliverables";

/**
 * Cycle de vie des missions en file d'attente (recommandation A de l'audit).
 *
 * Chaque mission async possède un document `missionQueue` : c'est la source
 * de vérité pour le STATUT vu par le client (polling /api/agents/runs/[runId]
 * et flux SSE /api/agents/runs/[runId]/stream) pendant que le checkpoint
 * runtime (collection `executions`) reste la source de vérité du TRAVAIL
 * (étapes, sorties, reprise). Les deux rôles restent séparés : le document
 * de file est petit et lisible en un GET, le checkpoint est volumineux et
 * écrit par le runtime lui-même.
 *
 * BAIL D'EXÉCUTION (lease) : le receiver /api/queue/mission-tick CLAIM le
 * document dans une TRANSACTION Firestore (statut queued/running + bail
 * expiré requis). Une redélivrance QStash pendant qu'un tick travaille est
 * donc un no-op (200 sans ré-exécution) — les doubles exécutions concurrentes
 * sont impossibles. Après un kill plateforme, le bail expire (90 s) et le
 * tick suivant reprend depuis le dernier checkpoint : la mission NE MEURT
 * JAMAIS avec la fonction.
 *
 * FAIL-SOFT : la progression/finalisation ne lèvent JAMAIS — une panne
 * Firestore de statut ne doit pas masquer un travail réel déjà accompli.
 *
 * GARDE QUOTA (Task 110-d) : chaque touche Firestore passe par
 * runFirestoreGuarded (lib/queue/firestore-guard) — deadline anti-stall 6 s
 * (Task 97 : sous quota quotidien épuisé, les écritures pendent SANS lever)
 * + disjoncteur quota (Task 95-b). Cause racine 110-d : ces touches brutes
 * faisaient pendre la requête chat (maxDuration 300) et fantomiser les
 * missions « queued » sous quota Firestore, pendant que le chat (R2)
 * répondait encore — « plus aucune tâche ne s'exécute ».
 */

const COLLECTION = "missionQueue";

/** Durée du bail d'exécution (ms) — couvre la fenêtre fonction + marge. */
export const MISSION_LEASE_MS = 90_000;

/** Délai (s) avant la délivrance du tick suivant après une pause d'échéance. */
export const NEXT_TICK_DELAY_SECONDS = 2;

export type MissionQueueStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused";

/** Étape de timeline compacte affichable (aperçu borné, jamais de binaire). */
export interface MissionQueueStep {
  id: string;
  name: string;
  type: string;
  status: string;
  outputPreview?: string;
}

const STEP_PREVIEW_LIMIT = 800;

export function compactQueueStep(step: {
  id: string;
  name?: string;
  type?: string;
  status?: string;
  output?: unknown;
}): MissionQueueStep {
  let outputPreview: string | undefined;
  const output = step.output;
  if (typeof output === "string" && output.trim()) {
    outputPreview = output.length > STEP_PREVIEW_LIMIT ? `${output.slice(0, STEP_PREVIEW_LIMIT)}…` : output;
  } else if (output !== undefined && output !== null) {
    try {
      const json = JSON.stringify(output);
      outputPreview = json.length > STEP_PREVIEW_LIMIT ? `${json.slice(0, STEP_PREVIEW_LIMIT)}…` : json;
    } catch {
      outputPreview = undefined;
    }
  }
  return {
    id: step.id,
    name: (step.name ?? step.id).slice(0, 200),
    type: (step.type ?? "llm").slice(0, 40),
    status: (step.status ?? "pending").slice(0, 30),
    ...(outputPreview ? { outputPreview } : {}),
  };
}

export interface CreateQueuedMissionInput {
  runId: string;
  executionId: string;
  userId: string;
  objective: string;
  projectId?: string;
  /** Organisation propriétaire (Task 58) — validée par la route appelante (assertOrgAttach) ; relayée sur l'exécution au tick. */
  orgId?: string;
  /** Plan COMPLET exécutable — le tick receiver le relit pour construire le runtime (le document de file est la seule mémoire entre deux ticks). */
  plan: RuntimePlan;
  /** Contrat de résultat (concepts #1/#2) : relayé au runtime par chaque tick. */
  outcomeContract?: OutcomeContract;
  messageId?: string;
  /** Conversation propriétaire (missions lancées depuis un chat) : le tick final y réconcilie le run, y publie la réponse et notifie la livraison. */
  conversationId?: string;
}

export interface MissionQueueRecord {
  runId: string;
  userId: string;
  executionId: string;
  objective: string;
  projectId?: string;
  /** Organisation propriétaire (Task 58) — présente sur les missions enfilées depuis un contexte d'organisation. */
  orgId?: string;
  status: MissionQueueStatus;
  attempts: number;
  leaseUntilMs?: number;
  lastError?: string;
  /** Plan complet (présent sur le record brut du claim — jamais renvoyé au client). */
  plan?: RuntimePlan;
  /** Contrat de résultat (présent quand la mission en porte un). */
  outcomeContract?: OutcomeContract;
  timeline: MissionQueueStep[];
  pendingCount: number;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  messageId?: string;
  conversationId?: string;
  /** Manifest des livrables réellement produits (artefacts, fichiers) — renseigné à la finalisation. */
  deliverables?: MissionDeliverable[];
}

function docRef(runId: string) {
  return adminDb.collection(COLLECTION).doc(runId);
}

/** Crée l'entrée de file (statut initial « queued »). Lève si l'écriture échoue : l'appelant doit savoir qu'il n'y a AUCUN worker derrière. Garde 110-d : une écriture SANS réponse en 6 s lève quota-classifié au lieu de pendre (repli synchrone du chat immédiat). */
export async function createQueuedMission(input: CreateQueuedMissionInput): Promise<void> {
  const now = Date.now();
  const steps = input.plan.steps;
  await runFirestoreGuarded(`create ${COLLECTION}/${input.runId}`, () => docRef(input.runId).set({
    runId: input.runId,
    userId: input.userId,
    executionId: input.executionId,
    objective: input.objective,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.orgId ? { orgId: input.orgId } : {}),
    status: "queued" satisfies MissionQueueStatus,
    attempts: 0,
    plan: input.plan,
    ...(input.outcomeContract ? { outcomeContract: input.outcomeContract } : {}),
    timeline: steps.map((step) => compactQueueStep(step)),
    pendingCount: steps.filter((step) => (step.status ?? "pending") === "pending").length,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    createdAtMs: now,
    updatedAtMs: now,
  }));
}

export type ClaimOutcome =
  | { kind: "claimed"; record: MissionQueueRecord }
  | { kind: "missing" }
  | { kind: "terminal"; status: MissionQueueStatus }
  | { kind: "lease-held" };

/**
 * Claim TRANSACTIONNEL d'un tick. Garantit qu'exactement UN worker exécute
 * une tranche à la fois : bail actif → no-op ; statut terminal → no-op
 * (redélivrance après complétion — QStash peut re-tenter un 5xx historique) ;
 * sinon bail posé et tentatives incrémentées DANS le même commit.
 */
export async function claimMissionTick(runId: string): Promise<ClaimOutcome> {
  // Garde 110-d : le claim transactionnel reste EXACTEMENT-UNE-FOIS, mais
  // sous deadline + disjoncteur — sous quota, le tick répond 500 (QStash
  // re-tente) en ~6 s au lieu de pendre jusqu'au kill de la fonction.
  return runFirestoreGuarded(`claim ${COLLECTION}/${runId}`, () => adminDb.runTransaction(async (tx) => {
    const ref = docRef(runId);
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return { kind: "missing" } as const;
    const data = snapshot.data() as Partial<MissionQueueRecord> | undefined;
    if (!data) return { kind: "missing" } as const;
    const status = (data.status ?? "queued") as MissionQueueStatus;
    if (status === "completed" || status === "failed" || status === "cancelled") {
      return { kind: "terminal", status } as const;
    }
    const leaseUntilMs = typeof data.leaseUntilMs === "number" ? data.leaseUntilMs : 0;
    if (status === "running" && leaseUntilMs > Date.now()) {
      return { kind: "lease-held" } as const;
    }
    const now = Date.now();
    tx.update(ref, {
      status: "running" satisfies MissionQueueStatus,
      attempts: FieldValue.increment(1),
      leaseUntilMs: now + MISSION_LEASE_MS,
      updatedAtMs: now,
      lastError: FieldValue.delete(),
    });
    return {
      kind: "claimed",
      record: {
        runId: data.runId ?? runId,
        userId: data.userId ?? "",
        executionId: data.executionId ?? "",
        objective: data.objective ?? "",
        ...(data.projectId ? { projectId: data.projectId } : {}),
        ...(typeof data.orgId === "string" && data.orgId ? { orgId: data.orgId } : {}),
        status: "running",
        attempts: (typeof data.attempts === "number" ? data.attempts : 0) + 1,
        leaseUntilMs: now + MISSION_LEASE_MS,
        ...(data.lastError ? { lastError: data.lastError } : {}),
        ...(data.plan ? { plan: data.plan as RuntimePlan } : {}),
        ...(data.outcomeContract ? { outcomeContract: data.outcomeContract as OutcomeContract } : {}),
        ...(typeof data.conversationId === "string" && data.conversationId ? { conversationId: data.conversationId } : {}),
        ...(Array.isArray(data.deliverables) ? { deliverables: data.deliverables as MissionDeliverable[] } : {}),
        timeline: Array.isArray(data.timeline) ? data.timeline : [],
        pendingCount: typeof data.pendingCount === "number" ? data.pendingCount : 0,
        createdAtMs: typeof data.createdAtMs === "number" ? data.createdAtMs : now,
        updatedAtMs: now,
      } satisfies MissionQueueRecord,
    } as const;
  }));
}

/** Progression (best-effort) : timeline compacte + compteur d'étapes restantes. */
export async function persistMissionProgress(
  runId: string,
  steps: Array<{ id: string; name?: string; type?: string; status?: string; output?: unknown }>,
): Promise<void> {
  try {
    const pendingCount = steps.filter((step) => step.status === "pending").length;
    await runFirestoreGuarded(`progress ${COLLECTION}/${runId}`, () => docRef(runId).set(
      {
        timeline: steps.map((step) => compactQueueStep(step)),
        pendingCount,
        updatedAtMs: Date.now(),
      },
      { merge: true },
    ));
  } catch (error) {
    console.error("[mission-queue] progression non persistée (fail-soft):", error instanceof Error ? error.message : error);
  }
}

/** Finalisation (best-effort) : libère le bail, fige le statut terminal ou « paused ». */
export async function finalizeMissionRun(
  runId: string,
  status: Exclude<MissionQueueStatus, "queued" | "running">,
  details: { error?: string; deliverables?: MissionDeliverable[] } = {},
): Promise<void> {
  try {
    await runFirestoreGuarded(`finalize ${COLLECTION}/${runId}`, () => docRef(runId).set(
      {
        status,
        leaseUntilMs: FieldValue.delete(),
        completedAtMs: status === "completed" || status === "failed" || status === "cancelled" ? Date.now() : FieldValue.delete(),
        ...(details.error ? { lastError: details.error.slice(0, 2_000) } : {}),
        ...(details.deliverables && details.deliverables.length > 0 ? { deliverables: details.deliverables } : {}),
        updatedAtMs: Date.now(),
      },
      { merge: true },
    ));
  } catch (error) {
    console.error("[mission-queue] finalisation non persistée (fail-soft):", error instanceof Error ? error.message : error);
  }
}

/** Marque un échec d'ENFILEMENT initial (la mission n'a jamais démarré). */
export async function markMissionEnqueueFailed(runId: string, error: unknown): Promise<void> {
  try {
    await runFirestoreGuarded(`enqueue-failed ${COLLECTION}/${runId}`, () => docRef(runId).set(
      {
        status: "failed" satisfies MissionQueueStatus,
        lastError: `File d'attente indisponible : ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000),
        completedAtMs: Date.now(),
        updatedAtMs: Date.now(),
      },
      { merge: true },
    ));
  } catch (secondaryError) {
    console.error("[mission-queue] échec d'enfilement non persisté:", secondaryError instanceof Error ? secondaryError.message : secondaryError);
  }
}

export type NextTickDecision = "reenqueue" | "terminal";

/**
 * Décision PURE de ré-enfilement après un tick (testée sans Firestore) :
 *  - « paused » SANS demande de pause utilisateur → échéance de tranche →
 *    la suite est ré-enfilée (c'est le cœur du pattern par tranches) ;
 *  - « paused » AVEC demande de pause utilisateur → terminal ici (la reprise
 *    reste manuelle, jamais forcée derrière le dos de l'utilisateur) ;
 *  - tout autre statut non-running est terminal.
 */
export function decideNextTick(input: {
  status: MissionQueueStatus;
  pendingStepsRemaining: boolean;
  userPauseRequested: boolean;
}): NextTickDecision {
  if (input.status === "paused" && !input.userPauseRequested && input.pendingStepsRemaining) {
    return "reenqueue";
  }
  return "terminal";
}

/** Lecture propriétaire-scopée pour le polling / SSE du client. Garde 110-d : sous quota, la lecture répond 503 quota-classifié (actionnable) au lieu de pendre ou de ressembler à une mission introuvable. */
export async function getMissionRun(userId: string, runId: string): Promise<MissionQueueRecord | null> {
  const snapshot = await runFirestoreGuarded(`get ${COLLECTION}/${runId}`, () => docRef(runId).get());
  if (!snapshot.exists) return null;
  const data = snapshot.data() as Partial<MissionQueueRecord> | undefined;
  if (!data || data.userId !== userId) return null; // 404 anti-énumération
  const now = Date.now();
  const status = (data.status ?? "queued") as MissionQueueStatus;
  return {
    runId: data.runId ?? runId,
    userId: data.userId,
    executionId: data.executionId ?? "",
    objective: data.objective ?? "",
    ...(data.projectId ? { projectId: data.projectId } : {}),
    status,
    attempts: typeof data.attempts === "number" ? data.attempts : 0,
    leaseUntilMs: typeof data.leaseUntilMs === "number" ? data.leaseUntilMs : undefined,
    ...(data.lastError ? { lastError: data.lastError } : {}),
    timeline: Array.isArray(data.timeline) ? data.timeline : [],
    ...(data.outcomeContract ? { outcomeContract: data.outcomeContract } : {}),
    ...(typeof data.conversationId === "string" && data.conversationId ? { conversationId: data.conversationId } : {}),
    ...(Array.isArray(data.deliverables) ? { deliverables: data.deliverables as MissionDeliverable[] } : {}),
    pendingCount: typeof data.pendingCount === "number" ? data.pendingCount : 0,
    createdAtMs: typeof data.createdAtMs === "number" ? data.createdAtMs : now,
    updatedAtMs: typeof data.updatedAtMs === "number" ? data.updatedAtMs : now,
    ...(typeof data.completedAtMs === "number" ? { completedAtMs: data.completedAtMs } : {}),
    ...(data.messageId ? { messageId: data.messageId } : {}),
  } as MissionQueueRecord;
}
