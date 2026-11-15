import { createHash } from "node:crypto";

import { adminDb } from "@/lib/firebase/admin";

/**
 * Stockage des abonnements Web Push (Task 100) — Firestore.
 *
 * Chemin : `users/{uid}/pushSubscriptions/{hashEndpoint}` où `hashEndpoint`
 * est le SHA-256 (base64url) de l'endpoint push. Le hash évite d'utiliser une
 * URL signée comme identifiant de document et borne la taille de l'id.
 *
 * Best-effort strict : un Firestore indisponible ne doit JAMAIS faire échouer
 * la souscription (l'utilisateur réessaiera) ni l'envoi d'un push (le centre
 * de notifications in-app reste la source de vérité). Aucune fonction ne
 * lève vers l'appelant métier — booléens et listes vides en repli.
 */

const COLLECTION = "pushSubscriptions";
const MAX_USER_AGENT_CHARS = 200;
/** Plafond de lecture : au-delà, les abonnements les plus anciens sont ignorés. */
const MAX_LISTED_SUBSCRIPTIONS = 50;

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
  userAgent?: string;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime: number | null;
  userAgent: string;
  createdAtMs: number;
  lastSeenAtMs: number;
}

/** SHA-256 base64url de l'endpoint — identifiant de document stable et sûr. */
export function hashEndpoint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("base64url");
}

/** User-agent tronqué (200 caractères) — jamais d'entête brut illimité. */
export function truncateUserAgent(userAgent: string | undefined): string {
  return (userAgent ?? "").slice(0, MAX_USER_AGENT_CHARS);
}

function subscriptionsFor(userId: string) {
  return adminDb.collection("users").doc(userId).collection(COLLECTION);
}

/** Sauvegarde l'abonnement (upsert idempotent) — true si écrit, false sinon. */
export async function upsertPushSubscription(userId: string, subscription: PushSubscriptionInput): Promise<boolean> {
  try {
    const endpoint = subscription.endpoint?.trim();
    const p256dh = subscription.keys?.p256dh?.trim();
    const auth = subscription.keys?.auth?.trim();
    if (!userId?.trim() || !endpoint || !p256dh || !auth) return false;

    const now = Date.now();
    const ref = subscriptionsFor(userId).doc(hashEndpoint(endpoint));
    // Ré-souscription du même appareil : createdAtMs conservé, clés fraîches
    // et lastSeenAtMs rafraîchis (le navigateur peut renégocier p256dh/auth).
    const existing = await ref.get();
    const storedCreatedAt = existing.get("createdAtMs");
    const createdAtMs = typeof storedCreatedAt === "number" && storedCreatedAt > 0 ? storedCreatedAt : now;
    await ref.set({
      endpoint,
      p256dh,
      auth,
      expirationTime: typeof subscription.expirationTime === "number" ? subscription.expirationTime : null,
      userAgent: truncateUserAgent(subscription.userAgent),
      createdAtMs,
      lastSeenAtMs: now,
    });
    return true;
  } catch {
    // Firestore indisponible : échec silencieux — l'appelant métier continue.
    return false;
  }
}

/** Supprime l'abonnement — idempotent (true même si l'abonnement est absent). */
export async function deletePushSubscription(userId: string, endpoint: string): Promise<boolean> {
  try {
    const trimmed = endpoint?.trim();
    if (!userId?.trim() || !trimmed) return false;
    await subscriptionsFor(userId).doc(hashEndpoint(trimmed)).delete();
    return true;
  } catch {
    // Idem : jamais de throw vers l'appelant métier.
    return false;
  }
}

/** Liste les abonnements, les plus récemment vus d'abord ([] si indisponible). */
export async function listPushSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
  try {
    if (!userId?.trim()) return [];
    const snapshot = await subscriptionsFor(userId)
      .orderBy("lastSeenAtMs", "desc")
      .limit(MAX_LISTED_SUBSCRIPTIONS)
      .get();
    const records: PushSubscriptionRecord[] = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const endpoint = typeof data.endpoint === "string" ? data.endpoint : "";
      const p256dh = typeof data.p256dh === "string" ? data.p256dh : "";
      const auth = typeof data.auth === "string" ? data.auth : "";
      // Ligne incomplète : inutilisable pour un envoi — ignorée plutôt que rejetée.
      if (!endpoint || !p256dh || !auth) continue;
      records.push({
        endpoint,
        keys: { p256dh, auth },
        expirationTime: typeof data.expirationTime === "number" ? data.expirationTime : null,
        userAgent: truncateUserAgent(typeof data.userAgent === "string" ? data.userAgent : undefined),
        createdAtMs: typeof data.createdAtMs === "number" ? data.createdAtMs : 0,
        lastSeenAtMs: typeof data.lastSeenAtMs === "number" ? data.lastSeenAtMs : 0,
      });
    }
    return records;
  } catch {
    return [];
  }
}
