import "server-only";

import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { isFirestoreMissingIndexError } from "@/lib/db/firestore-fallback";
import type { ConversationRun, RunPhase, RunStatus, RunStep, RunStepStatus } from "@/lib/domain/conversations/types";

/**
 * Run — exécution d'un plan ou d'un outil dans une conversation.
 * La timeline (steps ordonnés par phase) est stockée dans le document :
 * lecture en une requête pour l'affichage inline repliable.
 */

const COLLECTION = "conversationRuns";

export function makeStep(input: {
  phase: RunPhase;
  title: string;
  detail?: string;
  toolName?: string;
  toolInput?: unknown;
  status?: RunStepStatus;
}): RunStep {
  return {
    id: randomUUID(),
    phase: input.phase,
    title: input.title.slice(0, 200),
    detail: input.detail?.slice(0, 4000),
    toolName: input.toolName,
    toolInput: input.toolInput,
    status: input.status ?? "pending",
  };
}

function docFrom(id: string, data: FirebaseFirestore.DocumentData): ConversationRun {
  const steps = Array.isArray(data.steps) ? (data.steps as RunStep[]) : [];
  return {
    id,
    userId: String(data.userId ?? ""),
    conversationId: String(data.conversationId ?? ""),
    projectId: typeof data.projectId === "string" ? data.projectId : undefined,
    executionId: typeof data.executionId === "string" ? data.executionId : undefined,
    objective: String(data.objective ?? ""),
    status: (data.status ?? "planning") as RunStatus,
    steps: steps.map((s) => ({ ...s, id: String(s.id), phase: s.phase, title: String(s.title), status: s.status })),
    runtime: data.runtime && typeof data.runtime === "object" ? (data.runtime as Record<string, unknown>) : undefined,
    createdAt: data.createdAt instanceof Date ? data.createdAt.toISOString() : new Date().toISOString(),
    updatedAt: data.updatedAt instanceof Date ? data.updatedAt.toISOString() : new Date().toISOString(),
    finishedAt: data.finishedAt instanceof Date ? data.finishedAt.toISOString() : undefined,
  };
}

export async function createRun(input: {
  userId: string;
  conversationId: string;
  projectId?: string;
  /** Identifiant d'exécution runtime (mode agent : réconciliation après approbation). */
  executionId?: string;
  objective: string;
  steps: RunStep[];
  /** Payload runtime compact (plan, sorties, observations) pour ré-affichage fidèle. */
  runtime?: Record<string, unknown>;
}): Promise<ConversationRun> {
  const now = new Date();
  const ref = adminDb.collection(COLLECTION).doc(randomUUID());
  await ref.set({
    userId: input.userId,
    conversationId: input.conversationId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.executionId ? { executionId: input.executionId } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
    objective: input.objective.slice(0, 2000),
    status: "planning" as const,
    steps: input.steps,
    createdAt: now,
    updatedAt: now,
  });
  return {
    id: ref.id,
    userId: input.userId,
    conversationId: input.conversationId,
    projectId: input.projectId,
    executionId: input.executionId,
    objective: input.objective,
    status: "planning",
    steps: input.steps,
    runtime: input.runtime,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/** Retrouve le run d'une conversation lié à une exécution runtime (mode agent). */
export async function findRunByExecution(userId: string, executionId: string): Promise<ConversationRun | null> {
  const snap = await adminDb
    .collection(COLLECTION)
    .where("userId", "==", userId)
    .where("executionId", "==", executionId)
    .limit(1)
    .get();
  const doc = snap.docs[0];
  if (!doc) return null;
  return docFrom(doc.id, doc.data());
}

/**
 * Met à jour (upsert limité) le run lié à une exécution : statut final,
 * timeline et payload runtime. Fail-soft : l'absence de run (fils créés
 * avant la fonctionnalité) n'est pas une erreur.
 */
export async function updateRunByExecution(
  userId: string,
  executionId: string,
  patch: { status?: RunStatus; steps?: RunStep[]; runtime?: Record<string, unknown> },
): Promise<ConversationRun | null> {
  const existing = await findRunByExecution(userId, executionId);
  if (!existing) return null;
  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (patch.status) update.status = patch.status;
  if (patch.steps) update.steps = patch.steps;
  if (patch.runtime) update.runtime = patch.runtime;
  if (patch.status) update.finishedAt = FieldValue.serverTimestamp();
  await adminDb.collection(COLLECTION).doc(existing.id).update(update);
  return { ...existing, ...patch };
}

export async function getRun(userId: string, runId: string): Promise<ConversationRun | null> {
  const snap = await adminDb.collection(COLLECTION).doc(runId).get();
  if (!snap.exists || snap.data()?.userId !== userId) return null;
  return docFrom(snap.id, snap.data()!);
}

export async function getRunForConversation(userId: string, runId: string, conversationId: string): Promise<ConversationRun | null> {
  const run = await getRun(userId, runId);
  if (!run || run.conversationId !== conversationId) return null;
  return run;
}

export async function listRunsForConversation(userId: string, conversationId: string, limit = 20): Promise<ConversationRun[]> {
  const snap = await adminDb
    .collection(COLLECTION)
    .where("userId", "==", userId)
    .where("conversationId", "==", conversationId)
    .orderBy("createdAt", "desc")
    .limit(Math.min(limit, 50))
    .get();
  return snap.docs.map((d) => docFrom(d.id, d.data()));
}

/**
 * Missions récentes TOUTES conversations confondues (étape 16) : la vue
 * globale de l'activité d'exécution de l'utilisateur.
 *
 * Task 101 (M3 — réduction quota) : le chemin nominal s'appuie sur l'index
 * composite (userId, createdAt DESC) — orderBy SERVEUR + limit EXACT, soit
 * N lectures au lieu des 80 lectures arbitraires re-triées en mémoire
 * (historique : « scan 80 pour en afficher 8 »). Si l'index n'est pas (encore)
 * déployé, le repli historique absorbe l'erreur (FAILED_PRECONDITION) : la
 * disponibilité ne dépend JAMAIS du déploiement d'index.
 */
export async function listRecentRuns(userId: string, limit = 8): Promise<ConversationRun[]> {
  const capped = Math.min(limit, 20);
  try {
    const snap = await adminDb
      .collection(COLLECTION)
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(capped)
      .get();
    // Le serveur renvoie DIRECTEMENT les N plus récents (ordre garanti).
    return snap.docs.map((d) => docFrom(d.id, d.data()));
  } catch (error) {
    if (!isFirestoreMissingIndexError(error)) throw error;
    // Repli SANS index composite : filtre userId seul + tri en mémoire
    // (comportement historique, scan plafonné à 80) — coût dégradé,
    // disponibilité intacte, même sémantique de fenêtre.
    const snap = await adminDb
      .collection(COLLECTION)
      .where("userId", "==", userId)
      .limit(80)
      .get();
    return snap.docs
      .map((d) => docFrom(d.id, d.data()))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, capped);
  }
}

export async function updateRunSteps(userId: string, runId: string, steps: RunStep[]): Promise<void> {
  await adminDb.collection(COLLECTION).doc(runId).update({
    steps,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/** Statut dérivé de la timeline : la source de vérité reste les étapes. */
export function deriveRunStatus(steps: RunStep[]): RunStatus {
  const pendingApprovals = steps.filter((s) => s.status === "awaiting");
  if (pendingApprovals.length > 0) return "awaiting_approval";
  const running = steps.some((s) => s.status === "in_progress" || s.status === "pending");
  if (running) return "running";
  const failed = steps.some((s) => s.status === "failed");
  if (failed) return "failed";
  return "completed";
}

export async function finalizeRun(userId: string, runId: string, status: RunStatus, steps: RunStep[]): Promise<void> {
  await adminDb.collection(COLLECTION).doc(runId).update({
    status,
    steps,
    finishedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}
