import "server-only";

import { deletePushSubscription, listPushSubscriptions } from "./repository";

/**
 * Envoi Web Push serveur (Task 100) — Web Push / VAPID, via `web-push`.
 *
 * Objectif : alerter l'utilisateur même application FERMÉE. Le centre de
 * notifications in-app (cloche) et les notifications natives du navigateur
 * (lib/notifications/native.ts) ne fonctionnent que page ouverte ; le push
 * serveur couvre le cas restant — app fermée, onglet tué, appareil verrouillé.
 *
 * Dégradation gracieuse : sans clés VAPID configurées (local, preview),
 * `isPushConfigured()` répond false et TOUT le module est un no-op
 * silencieux — la plateforme fonctionne exactement comme avant la Task 100.
 *
 * Best-effort strict : un échec push ne doit JAMAIS bloquer le flux métier
 * (même contrat que lib/notifications/repository.ts). Aucune fonction ne
 * lève — les erreurs sont absorbées ici.
 */

/** Charge utile push — minimal, URL RELATIVE, < 4 Ko (limite des services push). */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

/** Forme minimale d'une notification persistée (cf. NotificationSchema). */
export interface PushNotificationLike {
  type: "approval_requested" | "info";
  title: string;
  body: string;
  conversationId?: string;
  executionId?: string;
}

/** Limite stricte des services push (FCM : 4 096 octets de charge utile). */
const MAX_PAYLOAD_BYTES = 4096;
/** Budget d'envoi : au plus 10 abonnements par utilisateur et par notification. */
const MAX_SUBSCRIPTIONS_PER_SEND = 10;
/** Statuts HTTP signifiant un abonnement MORT (endpoint expiré ou révoqué). */
const DEAD_SUBSCRIPTION_STATUS = new Set([404, 410]);
/** Repli du sujet VAPID si VAPID_SUBJECT est absent (format mailto exigé). */
const DEFAULT_VAPID_SUBJECT = "mailto:contact@gen3ia.online";

function readServerEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value !== "undefined" && value !== "null" ? value : undefined;
}

/**
 * Le push n'est actif QUE si les DEUX clés VAPID sont présentes (la clé
 * privée ne vit jamais dans le dépôt — uniquement process.env côté serveur).
 */
export function isPushConfigured(): boolean {
  return Boolean(readServerEnv("VAPID_PUBLIC_KEY") && readServerEnv("VAPID_PRIVATE_KEY"));
}

/**
 * Détails VAPID memoïsés PAR VALEUR de clé : setVapidDetails est appelé une
 * seule fois par couple de clés (coût nul ensuite) et se reconfigure
 * proprement si les variables d'environnement changent (tests, rotation).
 */
let appliedVapidKeys: { publicKey: string; privateKey: string } | null = null;

function ensureVapidDetails(webPush: typeof import("web-push")): void {
  const publicKey = readServerEnv("VAPID_PUBLIC_KEY");
  const privateKey = readServerEnv("VAPID_PRIVATE_KEY");
  if (!publicKey || !privateKey) return;
  if (appliedVapidKeys?.publicKey === publicKey && appliedVapidKeys?.privateKey === privateKey) return;
  webPush.setVapidDetails(readServerEnv("VAPID_SUBJECT") || DEFAULT_VAPID_SUBJECT, publicKey, privateKey);
  appliedVapidKeys = { publicKey, privateKey };
}

/**
 * Deep-link d'une notification — ALIGNEMENT À MAINTENIR avec
 * components/notifications/notification-center.tsx (champ `url` transmis à
 * showNativeNotification, Task 99-b). Logique réimplémentée ici côté serveur
 * (le composant client n'est pas importable en contexte serveur) :
 *   conversationId → /workspace/conversations/<id>
 *   executionId (tâche studio) → /studio?taskId=<id>
 *   sinon → /dashboard
 */
export function notificationUrlFrom(notification: PushNotificationLike): string {
  if (notification.conversationId) {
    return `/workspace/conversations/${encodeURIComponent(notification.conversationId)}`;
  }
  if (notification.executionId) {
    return `/studio?taskId=${encodeURIComponent(notification.executionId)}`;
  }
  return "/dashboard";
}

/**
 * Charge utile dérivée d'une notification créée — mêmes libellés que les
 * notifications natives côté client (notification-center.tsx) pour une
 * expérience cohérente : « Gen3ia — validation requise » pour une demande
 * d'approbation, sinon le titre préfixé Gen3ia.
 */
export function pushPayloadFromNotification(notification: PushNotificationLike): PushPayload {
  return {
    title: notification.type === "approval_requested" ? "Gen3ia — validation requise" : `Gen3ia — ${notification.title}`,
    body: notification.body ? notification.body.slice(0, 300) : "Une mise à jour de ta mission t'attend.",
    url: notificationUrlFrom(notification),
  };
}

/**
 * Endpoint MASQUÉ pour les journaux : on ne journalise JAMAIS l'endpoint
 * complet (URL signée qui permettrait d'envoyer des push à l'utilisateur)
 * ni les clés p256dh/auth — seuls les 8 derniers caractères suffisent au
 * débogage.
 */
export function maskedEndpoint(endpoint: string): string {
  const trimmed = endpoint ?? "";
  return trimmed.length <= 8 ? "…" : `…${trimmed.slice(-8)}`;
}

/**
 * Charge utile bornée : troncatures défensives puis réduction progressive du
 * corps jusqu'à passer sous la limite de 4 096 octets (les services push
 * rejettent une charge trop lourde d'un 413 définitif).
 */
export function compactPayload(payload: PushPayload): PushPayload {
  const title = (payload.title ?? "").trim().slice(0, 200) || "Gen3ia";
  const url = (payload.url ?? "").trim() || "/dashboard";
  let body = (payload.body ?? "").slice(0, 300);
  const build = (): PushPayload => ({ title, body, url });
  // Garde-fou : réduit le corps par moitiés successives jusqu'à tenir.
  while (body.length > 0 && Buffer.byteLength(JSON.stringify(build()), "utf8") > MAX_PAYLOAD_BYTES) {
    body = body.slice(0, Math.floor(body.length / 2));
  }
  return build();
}

/**
 * Envoie une notification push à TOUS les appareils d'un utilisateur.
 *
 * - Fire-and-forget côté appelant (`void sendPushToUser(...)`).
 * - Aucun abonnement → no-op. Push non configuré → no-op silencieux.
 * - Abonnement mort (404/410) → supprimé ; toute autre erreur (429, 5xx,
 *   réseau) est ignorée — le prochain envoi réessaiera naturellement.
 * - JAMAIS de throw : le flux métier (création de notification, mission
 *   agent) continue quoi qu'il arrive.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  try {
    if (!userId?.trim() || !isPushConfigured()) return;
    const subscriptions = (await listPushSubscriptions(userId)).slice(0, MAX_SUBSCRIPTIONS_PER_SEND);
    if (subscriptions.length === 0) return;
    // Import dynamique : web-push (et sa chaîne crypto) ne pèse pas sur le
    // cold start des fonctions serverless tant qu'aucun envoi n'est déclenché.
    const webPush = await import("web-push");
    ensureVapidDetails(webPush);
    const body = JSON.stringify(compactPayload(payload));
    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webPush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: subscription.keys,
              ...(typeof subscription.expirationTime === "number" ? { expirationTime: subscription.expirationTime } : {}),
            },
            body,
          );
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (typeof status === "number" && DEAD_SUBSCRIPTION_STATUS.has(status)) {
            // Abonnement mort : nettoyage — le navigateur se resouscrira au
            // prochain passage de l'utilisateur (permission conservée).
            await deletePushSubscription(userId, subscription.endpoint);
            console.warn(`[push] abonnement mort (${status}) supprimé : ${maskedEndpoint(subscription.endpoint)}`);
          }
          // Toute autre erreur : ignorée (best-effort strict).
        }
      }),
    );
  } catch {
    // Push best-effort : aucune erreur ne remonte vers l'appelant métier.
  }
}
