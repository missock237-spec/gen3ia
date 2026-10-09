import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { runFirestoreGuarded } from "@/lib/queue/firestore-guard";
import type { AgentRole } from "@/lib/agents/orchestrator";
import { emitOutgoingEventSafe } from "@/lib/integrations/webhooks/emit";
import { notifyApprovalRequested, notifyApprovalResolved } from "@/lib/integrations/messaging/notify";
import { createNotification, markNotificationsForApprovalRead } from "@/lib/notifications/repository";

/**
 * Approbations HITL (collection `agentActionApprovals`, FIRESTORE — Task 110-e).
 *
 * Chemin utilisateur : waiting_approval du chat (route.ts ~700 —
 * createActionApproval après le createCheckpoint 110-d, listActionApprovals
 * après chaque repli synchrone), reprise après approbation
 * (/api/agent/chat/approve → approve/reject/claim/complete/fail) et
 * validation à distance (notifications → messaging approvals, orchestrator).
 *
 * GARDE 110-e : chaque touche Firestore passe par runFirestoreGuarded
 * (lib/queue/firestore-guard) — deadline anti-stall 6 s (Task 97 : sous
 * quota quotidien épuisé les écritures pendent SANS lever — sans garde,
 * createActionApproval pendait la requête chat jusqu'au kill maxDuration
 * et la transaction d'approbation pendait la reprise de la mission) +
 * disjoncteur quota (Task 95-b). Sémantique inchangée : les fonctions
 * lèvent déjà — l'erreur devient rapide et quota-classifiée (503
 * actionnable) au lieu d'une pendule ; sous disjoncteur ouvert le rejet
 * est immédiat et Firestore n'est JAMAIS touché.
 */

export const ACTION_APPROVAL_TTL_MS = 15 * 60 * 1000;
export const ActionApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "executing", "completed", "failed", "expired"]);
export type ActionApprovalStatus = z.infer<typeof ActionApprovalStatusSchema>;
const ApprovalSchema = z.object({ id: z.string().min(1).max(256), ownerId: z.string().min(1).max(256), executionId: z.string().min(1).max(256), role: z.enum(["customer_service", "sales", "content", "admin", "analytics"]), toolSlug: z.string().min(1).max(256), arguments: z.record(z.string(), z.unknown()), reason: z.string().min(1).max(4000), status: ActionApprovalStatusSchema, createdAt: z.number().int().positive(), expiresAt: z.number().int().positive(), approvedAt: z.number().int().positive().optional(), rejectedAt: z.number().int().positive().optional(), startedAt: z.number().int().positive().optional(), completedAt: z.number().int().positive().optional(), result: z.unknown().optional(), error: z.string().max(4000).optional() });
export type ActionApproval = z.infer<typeof ApprovalSchema>;
const COLLECTION = "agentActionApprovals";
const FORBIDDEN_KEYS = /^(password|passcode|secret|token|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|cookie|authorization|credential|recovery[_-]?code)$/i;
const MAX_ARGUMENTS_BYTES = 100_000; const MAX_RESULT_BYTES = 20_000;
function sanitizeValue(value: unknown, depth = 0): unknown { if (depth > 8) throw new Error("Action arguments are too deeply nested."); if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return typeof value === "string" && value.length > 10_000 ? value.slice(0, 10_000) : value; if (Array.isArray(value)) return value.slice(0, 500).map((item) => sanitizeValue(item, depth + 1)); if (typeof value === "object") { const output: Record<string, unknown> = {}; for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 500)) { if (FORBIDDEN_KEYS.test(key)) throw new Error(`Sensitive field "${key}" cannot be stored in an action approval.`); output[key] = sanitizeValue(item, depth + 1); } return output; } throw new Error("Unsupported action argument type."); }
function boundedResult(value: unknown): unknown { if (value === undefined) return undefined; try { const serialized = JSON.stringify(value); if (serialized.length > MAX_RESULT_BYTES) return serialized.slice(0, MAX_RESULT_BYTES); return JSON.parse(serialized); } catch { return "[unserializable]"; } }
function assertOwner(ownerId: string) { if (!ownerId?.trim()) throw new Error("Action approval requires ownerId."); }
async function readDoc(ownerId: string, id: string) { assertOwner(ownerId); const snapshot = await runFirestoreGuarded(`approval get ${COLLECTION}/${id}`, () => adminDb.collection(COLLECTION).doc(id).get()); if (!snapshot.exists || snapshot.get("ownerId") !== ownerId) throw new Error("Action approval not found."); return snapshot; }
function broadcastApprovalEvent(approval: ActionApproval, event: Parameters<typeof emitOutgoingEventSafe>[0]["event"]) {
  try {
    emitOutgoingEventSafe({ userId: approval.ownerId, event, payload: { approvalId: approval.id, executionId: approval.executionId, toolSlug: approval.toolSlug, role: approval.role, status: approval.status } });
  } catch { /* jamais bloquant */ }
}

export async function createActionApproval(params: { ownerId: string; executionId: string; role: AgentRole; toolSlug: string; arguments: Record<string, unknown>; reason: string; ttlMs?: number }): Promise<ActionApproval> { assertOwner(params.ownerId); if (!params.toolSlug.trim()) throw new Error("toolSlug is required."); if (!params.reason.trim()) throw new Error("reason is required."); const safeArguments = sanitizeValue(params.arguments) as Record<string, unknown>; if (JSON.stringify(safeArguments).length > MAX_ARGUMENTS_BYTES) throw new Error("Action arguments exceed the approval limit."); const now = Date.now(); const expiresAt = now + Math.max(30_000, Math.min(params.ttlMs ?? ACTION_APPROVAL_TTL_MS, 60 * 60 * 1000)); const ref = adminDb.collection(COLLECTION).doc(); await runFirestoreGuarded(`approval create ${ref.id}`, () => ref.create({ ownerId: params.ownerId, executionId: params.executionId, role: params.role, toolSlug: params.toolSlug, arguments: safeArguments, reason: params.reason.slice(0, 4000), status: "pending", createdAt: Timestamp.fromMillis(now), expiresAt: Timestamp.fromMillis(expiresAt) })); const approval = await getActionApproval(params.ownerId, ref.id); broadcastApprovalEvent(approval, "approval.requested"); void notifyApprovalRequested(approval);
// Notification in-app VALIDABLE À DISTANCE : l'utilisateur peut approuver ou rejeter depuis le centre de notifications, même s'il n'est pas dans le chat.
void createNotification({ userId: params.ownerId, type: "approval_requested", title: `Validation requise · ${params.toolSlug}`, body: params.reason.slice(0, 400), kind: "agent_action", approvalId: approval.id, executionId: params.executionId, toolSlug: params.toolSlug }); return approval; }
export async function listActionApprovals(ownerId: string, executionId: string): Promise<ActionApproval[]> {
  assertOwner(ownerId);
  const snapshot = await runFirestoreGuarded(`approval list ${executionId}`, () => adminDb.collection(COLLECTION)
    .where("ownerId", "==", ownerId)
    .where("executionId", "==", executionId)
    .get());
  return Promise.all(snapshot.docs.map((doc) => getActionApproval(ownerId, doc.id)));
}

export async function getActionApproval(ownerId: string, id: string): Promise<ActionApproval> { const snapshot = await readDoc(ownerId, id); const data = snapshot.data()!; return ApprovalSchema.parse({ id: snapshot.id, ownerId: data.ownerId, executionId: data.executionId, role: data.role, toolSlug: data.toolSlug, arguments: data.arguments ?? {}, reason: data.reason, status: data.status, createdAt: (data.createdAt as Timestamp).toMillis(), expiresAt: (data.expiresAt as Timestamp).toMillis(), approvedAt: data.approvedAt instanceof Timestamp ? data.approvedAt.toMillis() : undefined, rejectedAt: data.rejectedAt instanceof Timestamp ? data.rejectedAt.toMillis() : undefined, startedAt: data.startedAt instanceof Timestamp ? data.startedAt.toMillis() : undefined, completedAt: data.completedAt instanceof Timestamp ? data.completedAt.toMillis() : undefined, result: data.result, error: data.error }); }
export async function approveAction(ownerId: string, id: string): Promise<ActionApproval> { assertOwner(ownerId); const ref = adminDb.collection(COLLECTION).doc(id); await runFirestoreGuarded(`approval approve ${id}`, () => adminDb.runTransaction(async (tx) => { const snapshot = await tx.get(ref); if (!snapshot.exists || snapshot.get("ownerId") !== ownerId) throw new Error("Action approval not found."); if (snapshot.get("status") !== "pending") throw new Error(`Action approval cannot be approved from status "${snapshot.get("status")}".`); if (Date.now() >= (snapshot.get("expiresAt") as Timestamp).toMillis()) { tx.update(ref, { status: "expired" }); return; } tx.update(ref, { status: "approved", approvedAt: FieldValue.serverTimestamp() }); })); const result = await getActionApproval(ownerId, id); if (result.status === "expired") throw new Error("Action approval has expired."); broadcastApprovalEvent(result, "approval.approved"); void notifyApprovalResolved(result, "approved"); void markNotificationsForApprovalRead(ownerId, id); return result; }
export async function rejectAction(ownerId: string, id: string): Promise<ActionApproval> { assertOwner(ownerId); const ref = adminDb.collection(COLLECTION).doc(id); await runFirestoreGuarded(`approval reject ${id}`, () => adminDb.runTransaction(async (tx) => { const snapshot = await tx.get(ref); if (!snapshot.exists || snapshot.get("ownerId") !== ownerId) throw new Error("Action approval not found."); const status = snapshot.get("status") as ActionApprovalStatus; if (status !== "pending" && status !== "approved") throw new Error(`Action approval cannot be rejected from status "${status}".`); tx.update(ref, { status: "rejected", rejectedAt: FieldValue.serverTimestamp() }); })); const result = await getActionApproval(ownerId, id); broadcastApprovalEvent(result, "approval.rejected"); void notifyApprovalResolved(result, "rejected"); void markNotificationsForApprovalRead(ownerId, id); return result; }
export async function claimActionExecution(ownerId: string, id: string): Promise<ActionApproval> { assertOwner(ownerId); const ref = adminDb.collection(COLLECTION).doc(id); await runFirestoreGuarded(`approval claim ${id}`, () => adminDb.runTransaction(async (tx) => { const snapshot = await tx.get(ref); if (!snapshot.exists || snapshot.get("ownerId") !== ownerId) throw new Error("Action approval not found."); if (snapshot.get("status") !== "approved") throw new Error(`Action approval is not executable from status "${snapshot.get("status")}".`); if (Date.now() >= (snapshot.get("expiresAt") as Timestamp).toMillis()) { tx.update(ref, { status: "expired" }); return; } tx.update(ref, { status: "executing", startedAt: FieldValue.serverTimestamp() }); })); const result = await getActionApproval(ownerId, id); if (result.status === "expired") throw new Error("Action approval has expired."); return result; }
export async function completeAction(ownerId: string, id: string, result: unknown): Promise<ActionApproval> { const ref = adminDb.collection(COLLECTION).doc(id); await runFirestoreGuarded(`approval complete ${id}`, () => adminDb.runTransaction(async (tx) => { const snapshot = await tx.get(ref); if (!snapshot.exists || snapshot.get("ownerId") !== ownerId || snapshot.get("status") !== "executing") throw new Error("Action is not currently executing."); tx.update(ref, { status: "completed", result: boundedResult(result), completedAt: FieldValue.serverTimestamp() }); })); const approval = await getActionApproval(ownerId, id); broadcastApprovalEvent(approval, "approval.completed"); return approval; }
export async function failAction(ownerId: string, id: string, error: unknown): Promise<ActionApproval> { const ref = adminDb.collection(COLLECTION).doc(id); await runFirestoreGuarded(`approval fail ${id}`, () => adminDb.runTransaction(async (tx) => { const snapshot = await tx.get(ref); if (!snapshot.exists || snapshot.get("ownerId") !== ownerId || snapshot.get("status") !== "executing") throw new Error("Action is not currently executing."); const message = error instanceof Error ? error.message : "External action failed."; tx.update(ref, { status: "failed", error: message.slice(0, 4000), completedAt: FieldValue.serverTimestamp() }); })); const approval = await getActionApproval(ownerId, id); broadcastApprovalEvent(approval, "approval.failed"); return approval; }
