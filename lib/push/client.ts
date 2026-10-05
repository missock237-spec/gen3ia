/**
 * Abonnement Web Push côté client (Task 100-b).
 *
 * Complète le réglage « Notifications natives » : une fois la permission
 * accordée par l'utilisateur, le navigateur s'abonne au push serveur
 * (Web Push / VAPID) et transmet l'abonnement à POST /api/push/subscribe.
 * Le serveur peut alors alerter l'appareil même application fermée, avec
 * un payload { title, body, url } que le service worker affiche.
 *
 * Dégradation gracieuse assumée : si le push n'est pas possible
 * (navigateur sans PushManager, iOS < 16.4 sans PWA installée, clé
 * NEXT_PUBLIC_VAPID_PUBLIC_KEY absente, réseau en échec, clé VAPID
 * invalide), les fonctions retournent un échec typé — JAMAIS de throw —
 * et les notifications locales (rattrapage au retour d'onglet, Task 99-b)
 * continuent de fonctionner normalement.
 *
 * iOS : le push Web exige iOS ≥ 16.4 ET la PWA installée sur l'écran
 * d'accueil. Les appareils en dehors de ce périmètre n'exposent pas
 * window.PushManager (Safari antérieur, navigateur tiers iOS) :
 * isPushSupported() retourne simplement false — le navigateur fait déjà
 * le filtrage, le code n'a rien de spécial à faire.
 */

import { authFetch } from "@/lib/firebase/auth-client";

export type PushFailureReason = "unsupported" | "permission" | "unconfigured" | "error";

export type PushSubscribeResult =
  | { ok: true; endpoint: string }
  | { ok: false; reason: PushFailureReason };

/** Instantané transmissible d'un abonnement push navigateur. */
export interface PushSubscriptionSnapshot {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

/**
 * Support du push Web sur cet appareil : window présent, service worker
 * disponible, PushManager exposé (absent sur Safari iOS < 16.4 et dans
 * les webviews) et l'API Notification existante (permission).
 */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

/**
 * Clé publique VAPID (base64url, 87 caractères pour une clé P-256) →
 * Uint8Array attendu par pushManager.subscribe (applicationServerKey).
 * Gère le padding absent et les caractères -/_ du alphabet base64url.
 */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = `${base64Url}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Extrait l'instantané transmissible depuis l'abonnement du navigateur. */
export function snapshotFromSubscription(subscription: PushSubscription): PushSubscriptionSnapshot {
  const json = subscription.toJSON();
  return {
    endpoint: typeof json.endpoint === "string" ? json.endpoint : subscription.endpoint,
    expirationTime: typeof json.expirationTime === "number" ? json.expirationTime : null,
    keys: {
      p256dh: json.keys?.p256dh ?? "",
      auth: json.keys?.auth ?? "",
    },
  };
}

/** Corps JSON de POST /api/push/subscribe (contrat serveur Task 100). */
export function buildSubscribeBody(subscription: PushSubscriptionSnapshot): string {
  return JSON.stringify({
    subscription: {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      // Champ optionnel du contrat : transmis seulement s'il a une valeur.
      ...(typeof subscription.expirationTime === "number"
        ? { expirationTime: subscription.expirationTime }
        : {}),
    },
  });
}

/** Corps JSON de DELETE /api/push/subscribe (désabonnement par endpoint). */
export function buildUnsubscribeBody(endpoint: string): string {
  return JSON.stringify({ endpoint });
}

/**
 * Abonne cet appareil au push serveur (à appeler APRÈS l'accord de la
 * permission — le réglage des Paramètres garantit cet ordre).
 *
 * Contrat de retour, sans exception levée :
 *  - "unsupported"   : pas de push Web ici (Safari iOS < 16.4 sans PWA
 *                      installée, webview, navigateur exotique) ;
 *  - "permission"    : la permission Notification n'est pas "granted" ;
 *  - "unconfigured"  : clé NEXT_PUBLIC_VAPID_PUBLIC_KEY absente du déploiement ;
 *  - "error"         : échec d'abonnement (clé VAPID invalide, quota,
 *                      réseau…) ou refus du serveur.
 */
export async function subscribeToPush(): Promise<PushSubscribeResult> {
  try {
    if (!isPushSupported()) return { ok: false, reason: "unsupported" };
    if (Notification.permission !== "granted") return { ok: false, reason: "permission" };

    const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!publicKey) return { ok: false, reason: "unconfigured" };

    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      }));

    const snapshot = snapshotFromSubscription(subscription);
    const response = await authFetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: buildSubscribeBody(snapshot),
    });
    if (!response.ok) return { ok: false, reason: "error" };
    return { ok: true, endpoint: snapshot.endpoint };
  } catch {
    // BadRequestError (clé VAPID invalide), quota dépassé, réseau
    // indisponible… : les notifications locales restent la garantie.
    return { ok: false, reason: "error" };
  }
}

/**
 * Désabonne cet appareil du push serveur. Idempotent et silencieux :
 * pas d'abonnement local = succès immédiat (rien à faire), tout échec
 * (réseau, endpoint déjà purgé côté serveur) retourne simplement false.
 */
export async function unsubscribeFromPush(): Promise<boolean> {
  try {
    if (!isPushSupported()) return false;
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return true;
    const unsubscribed = await subscription.unsubscribe();
    // false = déjà désabonné côté navigateur : considéré comme fait.
    if (!unsubscribed) return true;
    const response = await authFetch("/api/push/subscribe", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: buildUnsubscribeBody(subscription.endpoint),
    });
    return response.ok;
  } catch {
    return false;
  }
}
