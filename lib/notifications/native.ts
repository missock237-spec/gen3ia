/**
 * Notifications NATIVES de l'appareil (étape 18 du plan 20).
 *
 * État des lieux corrigé : le centre de notifications émettait une
 * notification native pour les approbations, MAIS rien ne demandait jamais
 * la permission au navigateur (statut « default » → silence perpétuel) et
 * l'API `new Notification()` échoue sur Android (dépréciée : il faut passer
 * par le service worker). Ce module fournit la chaîne complète et réelle :
 *  1. choix utilisateur explicite (Paramètres) persisté ;
 *  2. demande de permission au bon moment (action de l'utilisateur) ;
 *  3. affichage via new Notification (desktop) AVEC repli automatique sur
 *     le service worker showNotification (Android + app installée) ;
 *  4. clic sur la notification : retour dans l'app (focus + navigation).
 */

export type NativePermissionState = "unsupported" | "default" | "granted" | "denied";
export type NativeToggleState = "enabled" | "disabled";

const STORAGE_KEY = "gen3ia-native-notif";
const SESSION_SHOWN_KEY = "gen3ia-native-shown";

/* ----------------------------- État local ----------------------------- */

export function isNativeNotificationsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "enabled";
  } catch {
    return false;
  }
}

export function setNativeNotificationsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "enabled" : "disabled");
  } catch {
    /* stockage indisponible : le choix vit pour la session */
  }
}

export function nativePermissionState(): NativePermissionState {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  const permission = Notification.permission;
  return permission === "granted" ? "granted" : permission === "denied" ? "denied" : "default";
}

/**
 * Demande la permission AU NOM du choix explicite de l'utilisateur (bouton
 * des Paramètres). Retourne l'état final réel du navigateur.
 */
export async function requestNativeNotifications(): Promise<NativePermissionState> {
  const current = nativePermissionState();
  if (current === "unsupported") return "unsupported";
  if (current !== "default") return current;
  try {
    const result = await Notification.requestPermission();
    return result === "granted" ? "granted" : result === "denied" ? "denied" : "default";
  } catch {
    return "denied";
  }
}

/* --------------------------- Logique pure (tests) --------------------------- */

export interface NativeEligibilityInput {
  permission: NativePermissionState;
  enabled: boolean;
  /** L'onglet est caché : l'utilisateur regarde ailleurs — c'est LÀ que la
   * notification native a de la valeur (pas de spam quand il est déjà dedans). */
  isHidden: boolean;
  /** Déjà montrée pendant cette session (déduplication stricte par id). */
  alreadyShown: boolean;
}

export function shouldShowNativeNotification(input: NativeEligibilityInput): boolean {
  if (!input.enabled) return false;
  if (input.permission !== "granted") return false;
  if (input.alreadyShown) return false;
  return input.isHidden;
}

/** Déduplication par session : ids déjà montrés (plafonné à 200). */
export function alreadyShownThisSession(id: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.sessionStorage.getItem(SESSION_SHOWN_KEY);
    const ids: string[] = raw ? JSON.parse(raw) : [];
    return ids.includes(id);
  } catch {
    return false;
  }
}

export function markShownThisSession(id: string): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.sessionStorage.getItem(SESSION_SHOWN_KEY);
    const ids: string[] = raw ? JSON.parse(raw) : [];
    const next = ids.includes(id) ? ids : [...ids.slice(-199), id];
    window.sessionStorage.setItem(SESSION_SHOWN_KEY, JSON.stringify(next));
  } catch {
    /* session storage indisponible : dédup seulement en mémoire du tour */
  }
}

/* --------------------------- Affichage natif --------------------------- */

export interface NativeNotificationPayload {
  title: string;
  body?: string;
  /** Déduplication côté OS : même tag = la notification remplace l'ancienne. */
  tag?: string;
  /** Chemin relatif ouvert au clic (ex. /studio?taskId=…). */
  url?: string;
}

/**
 * Affiche la notification native avec repli automatique :
 *  - desktop : `new Notification()` + onclick (focus + navigation) ;
 *  - Android / app installée : `registration.showNotification` via le
 *    service worker (new Notification y est dépréciée/interdite).
 */
export async function showNativeNotification(payload: NativeNotificationPayload): Promise<void> {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  const targetUrl = payload.url && payload.url.startsWith("/") ? payload.url : "/dashboard";

  // Repli Android / PWA installée : le service worker sait montrer et
  // gérer le clic (notificationclick) même fenêtre fermée.
  if ("serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration?.active && typeof registration.showNotification === "function") {
        await registration.showNotification(payload.title, {
          body: payload.body,
          tag: payload.tag,
          // renotify (re-alerte sur même tag) n'est pas dans le type DOM
          // standard mais est supporté par Chromium : passage non typé sûr.
          ...(payload.tag ? { renotify: true } : {}),
          data: { url: targetUrl },
          icon: "/icons/icon-192.png",
          badge: "/icons/icon-192.png",
        } as NotificationOptions);
        return;
      }
    } catch {
      /* on tente le chemin desktop ci-dessous */
    }
  }

  try {
    const notification = new Notification(payload.title, { body: payload.body, tag: payload.tag });
    notification.onclick = () => {
      window.focus();
      if (targetUrl !== window.location.pathname) window.location.assign(targetUrl);
      notification.close();
    };
  } catch {
    /* notification native indisponible sur cet appareil */
  }
}
