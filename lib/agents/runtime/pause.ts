/**
 * Contrôle de pause des exécutions d'agents.
 *
 * Principe : une exécution en cours consulte un document Firestore léger
 * (`agentPauseControls`) entre chaque lot d'étapes. Si une pause est
 * demandée, le runtime :
 *  1. arrête la boucle SANS marquer les étapes restantes en échec ;
 *  2. persiste le checkpoint complet (étapes déjà complétées conservées) ;
 *  3. retourne un état `paused` — l'appelant (route d'exécution) met la
 *     tâche workspace en `paused` à son tour.
 *
 * La reprise consiste à ré-exécuter le MÊME plan : les étapes déjà
 * terminées sont sautées par le planificateur DAG (getReadySteps), les
 * suivantes reprennent exactement où elles s'étaient arrêtées.
 *
 * Pause ≠ annulation : la pause préserve le travail payé (facturation LLM
 * déjà consommée) et permet la reprise ; l'annulation stoppe définitivement.
 *
 * ARRÊT (stop) : le même document de contrôle porte un `mode`. Sans mode
 * (ou mode "pause"), la demande est une pause — le runtime met l'état à
 * "paused" et la reprise est possible. Avec mode "stop", la demande est un
 * ARRÊT DÉFINITIF demandé par l'utilisateur à tout moment : le runtime
 * lève StopRequestedError dès sa prochaine consultation (entre les lots
 * d'étapes ET avant chaque étape), conserve le travail déjà payé dans le
 * checkpoint et termine l'exécution à l'état "cancelled" — aucune reprise
 * possible sur la même exécution.
 */

import { FieldValue } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";

const CONTROLS = "agentPauseControls";

export class PauseRequestedError extends Error {
  constructor(executionId: string) {
    super(`Pause demandée pour l'exécution ${executionId}.`);
    this.name = "PauseRequestedError";
  }
}

/** Arrêt définitif demandé par l'utilisateur pendant une exécution. */
export class StopRequestedError extends Error {
  constructor(executionId: string) {
    super(`Arrêt demandé pour l'exécution ${executionId}.`);
    this.name = "StopRequestedError";
  }
}

export interface PauseRequest {
  userId: string;

  executionId: string;

  taskId?: string;

  agentId?: string;

  reason?: string;
}

function controlRef(executionId: string) {
  return adminDb.collection(CONTROLS).doc(executionId);
}

/**
 * Demande la pause d'une exécution. Idempotent : une pause déjà demandée
 * reste simplement en place. Le doc porte le userId pour l'autorisation
 * (seul le propriétaire peut lever sa propre pause).
 */
export async function requestExecutionPause(request: PauseRequest): Promise<void> {
  await controlRef(request.executionId).set(
    {
      userId: request.userId,
      executionId: request.executionId,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      ...(request.agentId ? { agentId: request.agentId } : {}),
      ...(request.reason ? { reason: request.reason.slice(0, 500) } : {}),
      requested: true,
      requestedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/**
 * Demande l'ARRÊT définitif d'une exécution (mode "stop" sur le doc de
 * contrôle). Idempotent. Le runtime consulte ce contrôle entre les lots
 * d'étapes ET avant chaque étape : l'arrêt prend effet au plus près de
 * l'étape en cours, sans jamais interrompre un appel LLM/outil à moitié
 * (le résultat partiels n'est pas persisté comme "completed").
 */
export async function requestExecutionStop(request: PauseRequest): Promise<void> {
  await controlRef(request.executionId).set(
    {
      userId: request.userId,
      executionId: request.executionId,
      mode: "stop",
      ...(request.taskId ? { taskId: request.taskId } : {}),
      ...(request.agentId ? { agentId: request.agentId } : {}),
      ...(request.reason ? { reason: request.reason.slice(0, 500) } : {}),
      requested: true,
      requestedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/** Lève la pause (reprise ou annulation de la demande). */
export async function clearExecutionPause(userId: string, executionId: string): Promise<void> {
  const ref = controlRef(executionId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return;
  if (snapshot.get("userId") !== userId) throw new Error("Pause control not found.");
  await ref.delete();
}

/**
 * Lit l'état de pause. Retourne false en cas d'incident Firestore : le
 * runtime ne doit JAMAIS être bloqué par une panne du contrôle de pause
 * (la sécurité de l'exécution repose sur les budgets, pas sur ce contrôle).
 */
export async function isExecutionPauseRequested(executionId: string): Promise<boolean> {
  try {
    const snapshot = await controlRef(executionId).get();
    return snapshot.exists && snapshot.get("requested") === true;
  } catch {
    return false;
  }
}

/** Vérifie la pause et lève PauseRequestedError si demandée. */
export async function assertNotPaused(executionId: string): Promise<void> {
  if (await isExecutionPauseRequested(executionId)) {
    throw new PauseRequestedError(executionId);
  }
}

/**
 * Lit la demande d'arrêt. Retourne false en cas d'incident Firestore : le
 * runtime ne doit JAMAIS être bloqué par une panne du contrôle (les budgets
 * restent la garantie de sécurité).
 */
export async function isExecutionStopRequested(executionId: string): Promise<boolean> {
  try {
    const snapshot = await controlRef(executionId).get();
    return snapshot.exists && snapshot.get("requested") === true && snapshot.get("mode") === "stop";
  } catch {
    return false;
  }
}

/** Vérifie l'arrêt et lève StopRequestedError si demandé. */
export async function assertNotStopped(executionId: string): Promise<void> {
  if (await isExecutionStopRequested(executionId)) {
    throw new StopRequestedError(executionId);
  }
}

export interface PauseRequestSummary {
  executionId: string;

  taskId?: string;

  agentId?: string;

  reason?: string;

  requestedAt: string | null;
}

/** Liste les demandes de pause actives d'un utilisateur (reprise / suivi). */
export async function listPauseRequests(userId: string, limit = 20): Promise<PauseRequestSummary[]> {
  const snapshot = await adminDb
    .collection(CONTROLS)
    .where("userId", "==", userId)
    .where("requested", "==", true)
    .limit(limit)
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    const requestedAt = data.requestedAt?.toDate?.().toISOString?.() ?? null;
    return {
      executionId: doc.id,
      ...(typeof data.taskId === "string" ? { taskId: data.taskId } : {}),
      ...(typeof data.agentId === "string" ? { agentId: data.agentId } : {}),
      ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
      requestedAt,
    };
  });
}
