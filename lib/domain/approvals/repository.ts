import "server-only";

import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import type { ApprovalStatus, ConversationApproval } from "@/lib/domain/conversations/types";

/**
 * Approval — action sensible nécessitant une validation humaine, affichée
 * en ligne dans la conversation avec un résumé clair : impact, outil,
 * données concernées et coût estimé.
 */

const COLLECTION = "conversationApprovals";

function docFrom(id: string, data: FirebaseFirestore.DocumentData): ConversationApproval {
  return {
    id,
    userId: String(data.userId ?? ""),
    conversationId: String(data.conversationId ?? ""),
    runId: String(data.runId ?? ""),
    stepId: String(data.stepId ?? ""),
    toolName: String(data.toolName ?? ""),
    title: String(data.title ?? "Action à valider"),
    impact: String(data.impact ?? ""),
    dataScope: String(data.dataScope ?? ""),
    estimatedCost: String(data.estimatedCost ?? ""),
    risk: String(data.risk ?? ""),
    status: (data.status ?? "pending") as ApprovalStatus,
    decidedAt: data.decidedAt instanceof Date ? data.decidedAt.toISOString() : undefined,
    createdAt: data.createdAt instanceof Date ? data.createdAt.toISOString() : new Date().toISOString(),
  };
}

export async function createApproval(input: {
  userId: string;
  conversationId: string;
  runId: string;
  stepId: string;
  toolName: string;
  title: string;
  impact: string;
  dataScope: string;
  estimatedCost: string;
  risk: string;
}): Promise<ConversationApproval> {
  const now = new Date();
  const ref = adminDb.collection(COLLECTION).doc(randomUUID());
  await ref.set({ ...input, status: "pending" as const, createdAt: now });
  return { ...input, status: "pending", id: ref.id, createdAt: now.toISOString() };
}

export async function getApproval(userId: string, approvalId: string): Promise<ConversationApproval | null> {
  const snap = await adminDb.collection(COLLECTION).doc(approvalId).get();
  if (!snap.exists || snap.data()?.userId !== userId) return null;
  return docFrom(snap.id, snap.data()!);
}

/** Décision idempotente : une décision déjà prise ne peut pas être changée. */
export async function decideApproval(
  userId: string,
  approvalId: string,
  decision: Exclude<ApprovalStatus, "pending">,
): Promise<{ approval: ConversationApproval; alreadyDecided: boolean }> {
  const ref = adminDb.collection(COLLECTION).doc(approvalId);
  const result = await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.userId !== userId) throw new Error("Validation introuvable.");
    const current = docFrom(snap.id, snap.data()!);
    if (current.status !== "pending") return { approval: current, alreadyDecided: true };
    const approved = decision === "approved";
    tx.update(ref, { status: decision, decidedAt: FieldValue.serverTimestamp() });
    return { approval: { ...current, status: decision, decidedAt: new Date().toISOString() }, alreadyDecided: false, approved };
  });
  return { approval: result.approval, alreadyDecided: result.alreadyDecided };
}

export async function listApprovalsForConversation(userId: string, conversationId: string, limit = 30): Promise<ConversationApproval[]> {
  const snap = await adminDb
    .collection(COLLECTION)
    .where("userId", "==", userId)
    .where("conversationId", "==", conversationId)
    .orderBy("createdAt", "desc")
    .limit(Math.min(limit, 100))
    .get();
  return snap.docs.map((d) => docFrom(d.id, d.data()));
}

export async function listPendingApprovals(userId: string, limit = 30): Promise<ConversationApproval[]> {
  const snap = await adminDb
    .collection(COLLECTION)
    .where("userId", "==", userId)
    .where("status", "==", "pending")
    .orderBy("createdAt", "desc")
    .limit(Math.min(limit, 100))
    .get();
  return snap.docs.map((d) => docFrom(d.id, d.data()));
}
