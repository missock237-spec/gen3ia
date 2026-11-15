import { Timestamp } from "@/lib/r2fs";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { runFirestoreGuarded } from "@/lib/queue/firestore-guard";
import { pushPayloadFromNotification, sendPushToUser } from "@/lib/push/server";
import { cacheDelete } from "@/lib/cache/redis";
import type { DocumentData } from "@/lib/r2fs";

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
 *
 * GARDE QUOTA (Task 110-e) : chaque touche Firestore passe par
 * runFirestoreGuarded (lib/queue/firestore-guard) — deadline anti-stall 6 s
 * (Task 97 : sous quota quotidien épuisé les écritures pendent SANS lever —
 * sans garde, createNotification pendait la LIVRAISON des missions en
 * arrière-plan — deliverMissionToConversation l'attend — jusqu'au kill du
 * tick) + disjoncteur quota (Task 95-b). Le contrat best-effort est
 * conservé : createNotification/markNotificationsForApprovalRead avalent
 * l'erreur (mais échouent VITE au lieu de pendre) ; les lectures/écritures
 * du centre de notifications (polling sonnette toutes les 25 s par client)
 * lèvent quota-classifié → 503 actionnable au lieu d'un 500 ou d'une
 * pendule.
 *
 * Task 108 : Firestore est l'unique moteur de données — le pilote de
 * bascule (ADR-006 retirée) et le miroir secondaire ont été supprimés ; la
 * sémantique des APPELS est inchangée (zod, micro-cache, best-effort).
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
    await runFirestoreGuarded(`notification create ${ref.id}`, () => ref.create({
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
    }));
    // La sonnette est servie depuis un micro-cache (polling 25 s) : une
    // notification NOUVELLE invalide la clé pour que le prochain poll la
    // voie immédiatement (latence réelle inchangée, charge Firestore −90 %).
    invalidateNotificationsCache(notification.userId);
    // Push serveur (Task 100) : alerte même APPLICATION FERMÉE (Web Push /
    // VAPID). Fire-and-forget strict — aucun échec push ne remonte ici ; no-op
    // silencieux si les clés VAPID ne sont pas configurées.
    void sendPushToUser(notification.userId, pushPayloadFromNotification(notification)).catch(() => undefined);
    return notification;
  } catch (error) {
    console.warn("[notifications] création impossible (non bloquant):", error instanceof Error ? error.message : error);
    return null;
  }
}

function docToNotification(id: string, data: DocumentData): Gen3iaNotification | null {
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

/**
 * MICRO-CACHE SONNETTE (performance & capacité, audit 09-2026).
 *
 * Le centre de notifications interroge GET /api/notifications?limit=30
 * toutes les 25 s par client ouvert. Sans cache, chaque poll déclenche
 * DEUX requêtes Firestore (liste + compteur) : à 10 000 clients ouverts,
 * cela représente ~800 lectures Firestore/s pour afficher une cloche.
 *
 * Stratégie : cache process-local court (TTL 20 s = filet de sécurité)
 * invalidé PAR ÉVÉNEMENT à chaque mutation (création, lecture, tout-lu).
 * Une notification nouvelle apparaît donc au poll suivant SANS latence
 * ajoutée, et le cas nominal (rien de neuf) est servi depuis la mémoire
 * (Task 108 : le cache lib/cache/redis.ts est en mémoire process-local).
 * La clé canonique est celle du seul appelant réel du produit
 * (NotificationCenter : limit=30, sans filtre unread) — toute autre
 * forme de requête contourne le cache côté route.
 */
export function notificationsCacheKey(userId: string, limit: number, unreadOnly: boolean): string {
  return `g3:notif:${userId}:${limit}:${unreadOnly ? 1 : 0}`;
}

/** Invalidation best-effort — jamais bloquante pour le flux métier. */
export function invalidateNotificationsCache(userId: string): void {
  cacheDelete(notificationsCacheKey(userId, 30, false)).catch(() => {
    /* Cache indisponible : le TTL de sécurité fait foi */
  });
}

export async function listNotifications(userId: string, limit = 30, unreadOnly = false): Promise<Gen3iaNotification[]> {
  let query = adminDb
    .collection(COLLECTION)
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .limit(Math.min(Math.max(limit, 1), 50));
  if (unreadOnly) query = query.where("read", "==", false) as typeof query;
  const snapshot = await runFirestoreGuarded(`notification list ${userId}`, () => query.get());
  return snapshot.docs
    .map((doc) => docToNotification(doc.id, doc.data()))
    .filter((item): item is Gen3iaNotification => item !== null);
}

export async function countUnreadNotifications(userId: string): Promise<number> {
  const snapshot = await runFirestoreGuarded(`notification count ${userId}`, () => adminDb.collection(COLLECTION).where("userId", "==", userId).where("read", "==", false).count().get());
  return Number(snapshot.data().count ?? 0);
}

export async function markNotificationRead(userId: string, id: string): Promise<void> {
  const ref = adminDb.collection(COLLECTION).doc(id);
  await runFirestoreGuarded(`notification read ${id}`, () => adminDb.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists || snapshot.get("userId") !== userId) return;
    tx.update(ref, { read: true });
  }));
  invalidateNotificationsCache(userId);
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  const snapshot = await runFirestoreGuarded(`notification list unread ${userId}`, () => adminDb.collection(COLLECTION).where("userId", "==", userId).where("read", "==", false).limit(100).get());
  if (snapshot.empty) return;
  const batch = adminDb.batch();
  for (const doc of snapshot.docs) batch.update(doc.ref, { read: true });
  await runFirestoreGuarded(`notification read-all ${userId}`, () => batch.commit());
  invalidateNotificationsCache(userId);
}

/**
 * Marque comme lues toutes les notifications rattachées à une approbation
 * (décidée côté métier) — appelé best-effort par les deux systèmes
 * d'approbation (agent_action et conversation).
 */
export async function markNotificationsForApprovalRead(userId: string, approvalId: string): Promise<void> {
  try {
    const snapshot = await runFirestoreGuarded(`notification list approval ${approvalId}`, () => adminDb
      .collection(COLLECTION)
      .where("userId", "==", userId)
      .where("approvalId", "==", approvalId)
      .where("read", "==", false)
      .limit(20)
      .get());
    if (snapshot.empty) return;
    const batch = adminDb.batch();
    for (const doc of snapshot.docs) batch.update(doc.ref, { read: true });
    await runFirestoreGuarded(`notification read approval ${approvalId}`, () => batch.commit());
    invalidateNotificationsCache(userId);
  } catch (error) {
    console.warn("[notifications] marquage lu par approbation impossible (non bloquant):", error instanceof Error ? error.message : error);
  }
}
