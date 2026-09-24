import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";

/**
 * Centre de notifications persistantes Gen3ia (collection `notifications`).
 *
 * But premier : permettre la validation à DISTANCE des actions sensibles —
 * quand un agent demande l'accord de l'utilisateur et que celui-ci n'est pas
 * dans le chat, une notification in-app lui parvient avec des boutons
 * « Approuver » / « Rejeter » directement actionnables.
 *
 * Le module est server-only (Firebase Admin) et best-effort pour l'émetteur :
 * un échec de notification ne doit JAMAIS bloquer le flux métier.
 */

const COLLECTION = "notifications";

export const NotificationSchema = z.object({
  id: z.string().min(1).max(256),
  userId: z.string().min(1).max(256),
  type: z.enum(["approval_requested", "info"]),
  title: z.string().min(1).max(200),
  body: z.string().max(800).default(""),
  read: z.boolean().default(false),
  /** Actionnable : la notification porte une validation d'action sensible. */
  kind: z.enum(["agent_action", "conversation"]).optional(),
  approvalId: z.string().max(256).optional(),
  conversationId: z.string().max(256).optional(),
  executionId: z.string().max(256).optional(),
  toolSlug: z.string().max(256).optional(),
  createdAtMs: z.number().int().positive(),
});
export type Gen3iaNotification = z.infer<typeof NotificationSchema>;

export interface CreateNotificationInput {
  userId: string;
  type: Gen3iaNotification["type"];
  title: string;
  body?: string;
  kind?: Gen3iaNotification["kind"];
  approvalId?: string;
  conversationId?: string;
  executionId?: string;
  toolSlug?: string;
}

/** Crée une notification — jamais bloquant pour l'appelant. */
export async function createNotification(input: CreateNotificationInput): Promise<Gen3iaNotification | null> {
  try {
    if (!input.userId?.trim()) return null;
    const now = Date.now();
    const ref = adminDb.collection(COLLECTION).doc();
    const notification = NotificationSchema.parse({
      id: ref.id,
      userId: input.userId,
      type: input.type,
      title: input.title.slice(0, 200),
      body: (input.body ?? "").slice(0, 800),
      read: false,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.approvalId ? { approvalId: input.approvalId.slice(0, 256) } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId.slice(0, 256) } : {}),
      ...(input.executionId ? { executionId: input.executionId.slice(0, 256) } : {}),
      ...(input.toolSlug ? { toolSlug: input.toolSlug.slice(0, 256) } : {}),
      createdAtMs: now,
    });
    await ref.create({
      userId: notification.userId,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      read: false,
      ...(notification.kind ? { kind: notification.kind } : {}),
      ...(notification.approvalId ? { approvalId: notification.approvalId } : {}),
      ...(notification.conversationId ? { conversationId: notification.conversationId } : {}),
      ...(notification.executionId ? { executionId: notification.executionId } : {}),
      ...(notification.toolSlug ? { toolSlug: notification.toolSlug } : {}),
      createdAt: Timestamp.fromMillis(now),
    });
    return notification;
  } catch (error) {
    console.warn("[notifications] création impossible (non bloquant):", error instanceof Error ? error.message : error);
    return null;
  }
}

function docToNotification(id: string, data: FirebaseFirestore.DocumentData): Gen3iaNotification | null {
  const createdAt = data.createdAt;
  const parsed = NotificationSchema.safeParse({
    id,
    userId: data.userId,
    type: data.type === "approval_requested" ? "approval_requested" : "info",
    title: typeof data.title === "string" ? data.title : "Notification",
    body: typeof data.body === "string" ? data.body : "",
    read: data.read === true,
    ...(data.kind ? { kind: data.kind } : {}),
    ...(data.approvalId ? { approvalId: data.approvalId } : {}),
    ...(data.conversationId ? { conversationId: data.conversationId } : {}),
    ...(data.executionId ? { executionId: data.executionId } : {}),
    ...(data.toolSlug ? { toolSlug: data.toolSlug } : {}),
    createdAtMs: createdAt instanceof Timestamp ? createdAt.toMillis() : typeof createdAt === "number" ? createdAt : Date.now(),
  });
  return parsed.success ? parsed.data : null;
}

export async function listNotifications(userId: string, limit = 30, unreadOnly = false): Promise<Gen3iaNotification[]> {
  let query = adminDb
    .collection(COLLECTION)
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .limit(Math.min(Math.max(limit, 1), 50));
  if (unreadOnly) query = query.where("read", "==", false) as typeof query;
  const snapshot = await query.get();
  return snapshot.docs
    .map((doc) => docToNotification(doc.id, doc.data()))
    .filter((item): item is Gen3iaNotification => item !== null);
}

export async function countUnreadNotifications(userId: string): Promise<number> {
  const snapshot = await adminDb.collection(COLLECTION).where("userId", "==", userId).where("read", "==", false).count().get();
  return Number(snapshot.data().count ?? 0);
}

export async function markNotificationRead(userId: string, id: string): Promise<void> {
  const ref = adminDb.collection(COLLECTION).doc(id);
  await adminDb.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists || snapshot.get("userId") !== userId) return;
    tx.update(ref, { read: true });
  });
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  const snapshot = await adminDb.collection(COLLECTION).where("userId", "==", userId).where("read", "==", false).limit(100).get();
  if (snapshot.empty) return;
  const batch = adminDb.batch();
  for (const doc of snapshot.docs) batch.update(doc.ref, { read: true });
  await batch.commit();
}

/**
 * Marque comme lues toutes les notifications rattachées à une approbation
 * (décidée côté métier) — appelé best-effort par les deux systèmes
 * d'approbation (agent_action et conversation).
 */
export async function markNotificationsForApprovalRead(userId: string, approvalId: string): Promise<void> {
  try {
    const snapshot = await adminDb
      .collection(COLLECTION)
      .where("userId", "==", userId)
      .where("approvalId", "==", approvalId)
      .where("read", "==", false)
      .limit(20)
      .get();
    if (snapshot.empty) return;
    const batch = adminDb.batch();
    for (const doc of snapshot.docs) batch.update(doc.ref, { read: true });
    await batch.commit();
  } catch (error) {
    console.warn("[notifications] marquage lu par approbation impossible (non bloquant):", error instanceof Error ? error.message : error);
  }
}
