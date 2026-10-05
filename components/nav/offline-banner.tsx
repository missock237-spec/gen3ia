"use client";

import { useEffect, useState } from "react";

import { useToast } from "@/components/ui/toast";

/**
 * Bannière hors-ligne Gen3ia (réseaux instables — cible mobile-first).
 *
 * Sources d'état : les événements NATIFS window "offline"/"online" (le
 * composant pwa-register n'émet que "gen3ia:online", écouté ici aussi par
 * redondance) et "gen3ia:outbox-pending" relayé par le service worker quand
 * des missions patientent dans la file hors-ligne.
 *
 * - Hors ligne : bandeau discret fixe en bas, annoncé aux lecteurs d'écran
 *   (role="status" + aria-live="polite"), respect de safe-area-inset-bottom
 *   (PWA iOS standalone).
 * - Retour du réseau : le bandeau disparaît + toast « De retour en ligne ».
 * - File hors-ligne non vide : toast « Missions en attente d'envoi » (id
 *   stable : un seul toast visible même si l'événement se répète).
 *
 * Habillage 100 % tokens --g3-* : rendu correct dans les deux thèmes.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  const toast = useToast();

  useEffect(() => {
    // Synchronisation initiale (hydratation : navigator indisponible côté serveur).
    setOffline(!navigator.onLine);

    const goOffline = () => setOffline(true);
    const goOnline = () => {
      setOffline(false);
      toast.info("De retour en ligne", { id: "gen3ia-back-online" });
    };

    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    // Redondance : pwa-register émet "gen3ia:online" au retour du réseau
    // (même sémantique que l'événement natif "online").
    window.addEventListener("gen3ia:online", goOnline);
    // File hors-ligne non vide (relais service worker → pwa-register).
    const onOutboxPending = () => {
      toast.info("Missions en attente d'envoi — elles partiront au retour du réseau.", {
        id: "gen3ia-outbox-pending",
        durationMs: 7000,
      });
    };
    window.addEventListener("gen3ia:outbox-pending", onOutboxPending);

    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
      window.removeEventListener("gen3ia:online", goOnline);
      window.removeEventListener("gen3ia:outbox-pending", onOutboxPending);
    };
  }, [toast]);

  if (!offline) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-3"
      style={{ bottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <p
        role="status"
        aria-live="polite"
        className="g3-card max-w-[min(32rem,calc(100vw-1.5rem))] rounded-full border px-4 py-2 text-center text-xs font-medium shadow-lg"
        style={{
          background: "var(--g3-warning-soft)",
          color: "var(--g3-warning-strong)",
          borderColor: "var(--g3-border)",
        }}
      >
        Hors ligne — les modifications seront envoyées au retour du réseau
      </p>
    </div>
  );
}
