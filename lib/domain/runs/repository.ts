import "server-only";

import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
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
    objective: String(data.objective ?? ""),
    status: (data.status ?? "planning") as RunStatus,
    steps: steps.map((s) => ({ ...s, id: String(s.id), phase: s.phase, title: String(s.title), status: s.status })),
    createdAt: data.createdAt instanceof Date ? data.createdAt.toISOString() : new Date().toISOString(),
    updatedAt: data.updatedAt instanceof Date ? data.updatedAt.toISOString() : new Date().toISOString(),
    finishedAt: data.finishedAt instanceof Date ? data.finishedAt.toISOString() : undefined,
  };
}

export async function createRun(input: {
  userId: string;
  conversationId: string;
  projectId?: string;
  objective: string;
  steps: RunStep[];
}): Promise<ConversationRun> {
  const now = new Date();
  const ref = adminDb.collection(COLLECTION).doc(randomUUID());
  await ref.set({
    userId: input.userId,
    conversationId: input.conversationId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
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
    objective: input.objective,
    status: "planning",
    steps: input.steps,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
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
