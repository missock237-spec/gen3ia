"use client";

import * as React from "react";

import {
  isNativeNotificationsEnabled,
  nativePermissionState,
  requestNativeNotifications,
  setNativeNotificationsEnabled,
  type NativePermissionState,
} from "@/lib/notifications/native";

/**
 * Réglage « Notifications natives de l'appareil » (étape 18).
 *
 * Chaîne réelle : choix utilisateur explicite → demande de permission du
 * navigateur (au clic, jamais au chargement) → affichage natif des
 * nouvelles notifications quand l'utilisateur regarde ailleurs, avec
 * rattrapage au retour sur l'onglet des alertes nées pendant l'absence
 * (repli service worker sur Android et en app installée). L'état réel du
 * navigateur est toujours affiché — jamais une promesse non tenue.
 */
export function NativeNotificationsSetting() {
  const [permission, setPermission] = React.useState<NativePermissionState>("unsupported");
  const [enabled, setEnabled] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setPermission(nativePermissionState());
    setEnabled(isNativeNotificationsEnabled());
  }, []);

  const unsupported = permission === "unsupported";

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
    } finally {
      setBusy(false);
    }
  }

  function deactivate() {
    setNativeNotificationsEnabled(false);
    setEnabled(false);
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
        Recevez une notification quand une mission avance pendant que l&apos;application est en arrière-plan
        ou que votre onglet est inactif ; les alertes survenues pendant votre absence vous rattrapent
        dès votre retour sur l&apos;onglet. Désactivées par défaut : vous choisissez.
      </p>
      <p className={`mt-3 text-xs leading-5 ${permission === "denied" ? "text-[var(--g3-warning-strong)]" : "text-[var(--g3-faint)]"}`} role="status">
        {stateLabel}
      </p>
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
