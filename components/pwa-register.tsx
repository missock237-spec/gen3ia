"use client";

import { useEffect } from "react";

/**
 * Enregistre le service worker Gen3ia (PWA + exécution en arrière-plan) et
 * relaie à la page les reprises hors-ligne : quand une tâche envoyée hors
 * connexion est rejouée par Background Sync, la page reçoit l'événement
 * "gen3ia:outbox-flushed" pour rafraîchir l'historique et la conversation.
 */
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((reg) => {
      // Au retour de la connexion : demande de reprise immédiate (navigateurs
      // sans Background Sync) puis signal du retour en ligne à la page.
      window.addEventListener("online", () => {
        reg.active?.postMessage("gen3ia-flush");
        window.dispatchEvent(new CustomEvent("gen3ia:online"));
      });
      if (navigator.onLine) reg.active?.postMessage("gen3ia-flush");
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
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);

    return () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, []);

  return null;
}
