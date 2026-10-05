"use client";

import { useEffect, useState } from "react";

import { useToast } from "@/components/ui/toast";

/** Payload relayé par pwa-register (detail du CustomEvent) pour la file hors-ligne. */
type OutboxDetail = { pendingCount?: number };

/** Compteur du payload quand le service worker le fournit (sinon null). */
const readPendingCount = (event: Event): number | null => {
  const detail = (event as CustomEvent<OutboxDetail>).detail;
  return typeof detail?.pendingCount === "number" ? detail.pendingCount : null;
};

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
 *   stable : un seul toast visible même si l'événement se répète) ET pastille
 *   PERSISTANTE avec le nombre de missions en attente (« pendingCount » du
 *   service worker = longueur réelle de la file ; sinon incrément local) —
 *   décrémentée à chaque reprise (« gen3ia:outbox-flushed ») ou échec
 *   définitif (« gen3ia:outbox-failed »), masquée à zéro. Singulier/pluriel
 *   accordés en français.
 *
 * Habillage 100 % tokens --g3-* : rendu correct dans les deux thèmes.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
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
    // File hors-ligne non vide (relais service worker → pwa-register) :
    // le compteur du SW fait foi (longueur réelle de la file) ; sans lui,
    // incrément local conservateur.
    const onOutboxPending = (event: Event) => {
      const count = readPendingCount(event);
      setPendingCount((current) => (count === null ? current + 1 : Math.max(0, count)));
      toast.info("Missions en attente d'envoi — elles partiront au retour du réseau.", {
        id: "gen3ia-outbox-pending",
        durationMs: 7000,
      });
    };
    // Reprise OU échec définitif : l'item quitte la file — décrément (ou
    // vérité du service worker si fournie) ; à zéro la pastille disparaît.
    const onOutboxSettled = (event: Event) => {
      const count = readPendingCount(event);
      setPendingCount((current) =>
        count === null ? Math.max(0, current - 1) : Math.max(0, count),
      );
    };
    window.addEventListener("gen3ia:outbox-pending", onOutboxPending);
    window.addEventListener("gen3ia:outbox-flushed", onOutboxSettled);
    window.addEventListener("gen3ia:outbox-failed", onOutboxSettled);

    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
      window.removeEventListener("gen3ia:online", goOnline);
      window.removeEventListener("gen3ia:outbox-pending", onOutboxPending);
      window.removeEventListener("gen3ia:outbox-flushed", onOutboxSettled);
      window.removeEventListener("gen3ia:outbox-failed", onOutboxSettled);
    };
  }, [toast]);

  if (!offline && pendingCount <= 0) return null;

  // Habillage partagé des deux pastilles (hors-ligne et file en attente).
  const pillClass =
    "g3-card max-w-[min(32rem,calc(100vw-1.5rem))] rounded-full border px-4 py-2 text-center text-xs font-medium shadow-lg";
  const pillStyle = {
    background: "var(--g3-warning-soft)",
    color: "var(--g3-warning-strong)",
    borderColor: "var(--g3-border)",
  };

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2 px-3"
      style={{ bottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      {pendingCount > 0 && (
        <p role="status" aria-live="polite" className={pillClass} style={pillStyle}>
          {pendingCount === 1
            ? "1 mission en attente d'envoi"
            : `${pendingCount} missions en attente d'envoi`}
        </p>
      )}
      {offline && (
        <p role="status" aria-live="polite" className={pillClass} style={pillStyle}>
          Hors ligne — les modifications seront envoyées au retour du réseau
        </p>
      )}
    </div>
  );
}
