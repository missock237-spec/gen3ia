"use client";

import { useEffect } from "react";

/**
 * Enregistre le service worker Gen3ia (PWA + file hors-ligne) et relaie à la
 * page les reprises hors-ligne : quand une tâche envoyée hors connexion est
 * rejouée par Background Sync, la page reçoit "gen3ia:outbox-flushed" pour
 * rafraîchir l'historique. Les échecs définitifs (session expirée, payload
 * refusé, plafond de tentatives) sont relais "gen3ia:outbox-failed" — JAMAIS
 * de perte silencieuse.
 */
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const requestFlush = (registration: ServiceWorkerRegistration) => {
      // reg.active est souvent null juste après le PREMIER register (SW en
      // cours d'installation) : on attend l'état prêt pour ne pas perdre le
      // flush de démarrage.
      void navigator.serviceWorker.ready.then((ready) => {
        const target = registration.active ?? ready.active;
        target?.postMessage("gen3ia-flush");
      }).catch(() => undefined);
    };

    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((reg) => {
      // Au retour de la connexion : demande de reprise immédiate (navigateurs
      // sans Background Sync) puis signal du retour en ligne à la page.
      window.addEventListener("online", () => {
        requestFlush(reg);
        window.dispatchEvent(new CustomEvent("gen3ia:online"));
      });
      if (navigator.onLine) requestFlush(reg);
    }).catch(() => {
      /* Le service worker est optionnel. */
    });

    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const item of registrations) {
        void item.update().catch(() => undefined);
      }
    });

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } | null;
      if (data?.type === "gen3ia-outbox-flushed") {
        window.dispatchEvent(new CustomEvent("gen3ia:outbox-flushed", { detail: data }));
      } else if (data?.type === "gen3ia-outbox-failed") {
        window.dispatchEvent(new CustomEvent("gen3ia:outbox-failed", { detail: data }));
      } else if (data?.type === "gen3ia-outbox-pending") {
        window.dispatchEvent(new CustomEvent("gen3ia:outbox-pending", { detail: data }));
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);

    return () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, []);

  return null;
}
