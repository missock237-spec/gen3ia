import "server-only";

import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { createNotification, markNotificationsForApprovalRead } from "@/lib/notifications/repository";
import type { ApprovalStatus, ConversationApproval } from "@/lib/domain/conversations/types";

/**
 * Approval — action sensible nécessitant une validation humaine, affichée
 * en ligne dans la conversation avec un résumé clair : impact, outil,
 * données concernées et coût estimé.
 */

const COLLECTION = "conversationApprovals";

/**
 * Durée de validité d'une validation en attente (24 h). Une action sensible
 * décidée sur un contexte obsolète est un risque (données périmées, coût
 * inchangé, intention disparue) : au-delà de ce délai, la validation expire
 * et l'utilisateur relance une demande fraîche (audit 25-c : approvals
 * conversationnelles éternelles).
 */
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

function isExpired(status: ApprovalStatus, expiresAt?: string): boolean {
  if (status !== "pending" || !expiresAt) return false;
  const limit = new Date(expiresAt).getTime();
  return Number.isFinite(limit) && limit <= Date.now();
}

function docFrom(id: string, data: FirebaseFirestore.DocumentData): ConversationApproval {
  const status = (data.status ?? "pending") as ApprovalStatus;
  const expiresAt = data.expiresAt instanceof Date ? data.expiresAt.toISOString() : undefined;
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
    // Une validation en attente au-delà de son TTL est présentée comme
    // expirée (l'écriture définitive se fait dans decideApproval).
    status: isExpired(status, expiresAt) ? "expired" : status,
    expiresAt,
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
  await ref.set({ ...input, status: "pending" as const, createdAt: now, expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS) });
  // Notification in-app VALIDABLE À DISTANCE : l'utilisateur peut approuver
  // ou rejeter depuis le centre de notifications, même hors conversation.
  void createNotification({
    userId: input.userId,
    type: "approval_requested",
    title: input.title.slice(0, 200),
    body: [input.toolName, input.impact, input.estimatedCost].filter(Boolean).join(" · ").slice(0, 400),
    kind: "conversation",
    approvalId: ref.id,
    conversationId: input.conversationId,
    toolSlug: input.toolName,
  });
  return { ...input, status: "pending", id: ref.id, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString() };
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
    const raw = snap.data()!;
    // Expiration transactionnelle (évaluée sur les données BRUTES, avant tout
    // mapping) : une validation non décidée à temps est close automatiquement
    // — plus jamais de décision sur un contexte obsolète.
    const rawStatus = (raw.status ?? "pending") as ApprovalStatus;
    const rawExpiresAt = raw.expiresAt instanceof Date ? raw.expiresAt.toISOString() : undefined;
    if (rawStatus === "pending" && rawExpiresAt && new Date(rawExpiresAt).getTime() <= Date.now()) {
      tx.update(ref, { status: "expired", decidedAt: FieldValue.serverTimestamp() });
      return { approval: { ...docFrom(snap.id, raw), status: "expired" as const }, alreadyDecided: true };
    }
    const current = docFrom(snap.id, raw);
    if (current.status !== "pending") return { approval: current, alreadyDecided: true };
    const approved = decision === "approved";
    tx.update(ref, { status: decision, decidedAt: FieldValue.serverTimestamp() });
    return { approval: { ...current, status: decision, decidedAt: new Date().toISOString() }, alreadyDecided: false, approved };
  });
  // La décision prise : les notifications rattachées ne sont plus actionnables.
  if (!result.alreadyDecided) void markNotificationsForApprovalRead(userId, approvalId);
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
