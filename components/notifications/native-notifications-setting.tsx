"use client";

import * as React from "react";

import {
  isNativeNotificationsEnabled,
  nativePermissionState,
  requestNativeNotifications,
  setNativeNotificationsEnabled,
  type NativePermissionState,
} from "@/lib/notifications/native";
import { isPushSupported, subscribeToPush, unsubscribeFromPush } from "@/lib/push/client";

/** État de l'abonnement push serveur (affiché en sous-texte discret). */
type PushUiState = "idle" | "subscribing" | "done" | "failed";

/**
 * Réglage « Notifications natives de l'appareil » (étape 18, étendu Task 100-b).
 *
 * Chaîne réelle : choix utilisateur explicite → demande de permission du
 * navigateur (au clic, jamais au chargement) → affichage natif des
 * nouvelles notifications quand l'utilisateur regarde ailleurs, avec
 * rattrapage au retour sur l'onglet des alertes nées pendant l'absence
 * (repli service worker sur Android et en app installée). L'état réel du
 * navigateur est toujours affiché — jamais une promesse non tenue.
 *
 * Task 100-b : la permission accordée déclenche EN ARRIÈRE-PLAN
 * l'abonnement au push serveur (Web Push VAPID → POST /api/push/subscribe),
 * pour alerter même application fermée sur les appareils compatibles.
 * L'abonnement est non bloquant et silencieux en cas d'échec : le réglage
 * reste activé pour les notifications locales quoi qu'il arrive (seul un
 * sous-texte discret rapporte l'état réel du push sur cet appareil).
 */
export function NativeNotificationsSetting() {
  const [permission, setPermission] = React.useState<NativePermissionState>("unsupported");
  const [enabled, setEnabled] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [pushState, setPushState] = React.useState<PushUiState>("idle");

  React.useEffect(() => {
    setPermission(nativePermissionState());
    setEnabled(isNativeNotificationsEnabled());
  }, []);

  const unsupported = permission === "unsupported";

  /** Abonnement push serveur en arrière-plan : jamais bloquant, jamais bruyant. */
  function startPushSubscription() {
    // Pas de push Web ici (Safari iOS < 16.4 sans PWA installée, webview) :
    // on n'affiche rien — les notifications locales restent la promesse.
    if (!isPushSupported()) return;
    setPushState("subscribing");
    void subscribeToPush().then((outcome) => {
      if (outcome.ok) {
        setPushState("done");
        return;
      }
      // Dégradations attendues, sans alarmer : navigateur sans push, PWA
      // non installée sur iOS, clé serveur absente du déploiement → silence.
      if (outcome.reason === "unsupported" || outcome.reason === "unconfigured") {
        setPushState("idle");
        return;
      }
      setPushState("failed");
    });
  }

  async function activate() {
    setBusy(true);
    try {
      setNativeNotificationsEnabled(true);
      const result = await requestNativeNotifications();
      setPermission(result);
      setEnabled(true);
      // La permission refusée doit être comprise : l'utilisateur sait quoi
      // faire (réglages du navigateur) au lieu d'un silence perpétuel.
      if (result === "denied") setEnabled(false);
      // Task 100-b : permission accordée → abonnement au push serveur en
      // arrière-plan (non bloquant, silencieux) : le réglage reste activé
      // pour les notifications locales quoi qu'il arrive.
      if (result === "granted") startPushSubscription();
    } finally {
      setBusy(false);
    }
  }

  function deactivate() {
    setNativeNotificationsEnabled(false);
    setEnabled(false);
    setPushState("idle");
    // Task 100-b : retire aussi l'abonnement push serveur (fire-and-forget,
    // idempotent, jamais de throw — voir lib/push/client).
    void unsubscribeFromPush();
  }

  const stateLabel = unsupported
    ? "Non disponible sur cet appareil ou navigateur."
    : permission === "granted"
      ? "Permission accordée par le navigateur."
      : permission === "denied"
        ? "Permission refusée : réautorisez les notifications depuis les réglages de votre navigateur (icône cadenas dans la barre d'adresse)."
        : "Permission non encore demandée.";

  return (
    <section className="g3-gradient-border mt-6 p-6" aria-labelledby="settings-native-notif-title">
      <h2 id="settings-native-notif-title" className="font-[family-name:var(--font-display)] text-2xl font-semibold">
        Notifications natives de l&apos;appareil
      </h2>
      <p className="mt-2 text-sm leading-6 text-[var(--g3-muted)]">
        Recevez une alerte quand une mission avance, même application fermée, sur les appareils compatibles
        (Android/Chrome ; iPhone : iOS 16.4 ou plus avec l&apos;application installée). Sinon, les alertes locales
        vous rattrapent dès votre retour sur l&apos;onglet. Désactivées par défaut : vous choisissez.
      </p>
      <p className={`mt-3 text-xs leading-5 ${permission === "denied" ? "text-[var(--g3-warning-strong)]" : "text-[var(--g3-faint)]"}`} role="status">
        {stateLabel}
      </p>
      {pushState === "subscribing" && (
        <p className="mt-2 text-xs leading-5 text-[var(--g3-faint)]" role="status">
          Abonnement aux alertes serveur en cours…
        </p>
      )}
      {pushState === "done" && (
        <p className="mt-2 text-xs leading-5 text-[var(--g3-success-strong)]" role="status">
          Alertes serveur activées sur cet appareil.
        </p>
      )}
      {pushState === "failed" && (
        <p className="mt-2 text-xs leading-5 text-[var(--g3-warning-strong)]" role="status">
          Alertes serveur indisponibles sur cet appareil (les notifications locales restent actives).
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {!unsupported && !enabled && (
          <button
            type="button"
            onClick={() => void activate()}
            disabled={busy || permission === "denied"}
            className="inline-flex items-center gap-2 rounded-full bg-[var(--g3-gradient)] px-5 py-2.5 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
          >
            <span aria-hidden="true">🔔</span> {busy ? "Demande en cours…" : "Activer les notifications natives"}
          </button>
        )}
        {enabled && (
          <button
            type="button"
            onClick={deactivate}
            className="inline-flex items-center gap-2 rounded-full border border-[var(--g3-border)] px-5 py-2.5 text-sm font-semibold text-[var(--g3-text)] transition hover:bg-[var(--g3-elevated)]"
          >
            Désactiver
          </button>
        )}
        {enabled && (
          <span className="text-xs font-semibold text-[var(--g3-success-strong)]" role="status">
            Activé — les nouvelles alertes s&apos;affichent sur votre appareil.
          </span>
        )}
      </div>
    </section>
  );
}
