"use client";

import { useEffect } from "react";

/** Période entre deux vérifications de mise à jour du service worker. */
const SW_UPDATE_POLL_MS = 30 * 60 * 1000;
/** Garde anti-boucle : la page ne se recharge qu'UNE fois par session de
 * navigation pour appliquer une nouvelle version (clé de session). */
const RELOAD_FLAG = "gen3ia-sw-reloaded";

/**
 * Enregistre le service worker Gen3ia (PWA + file hors-ligne) et relaie à la
 * page les reprises hors-ligne : quand une tâche envoyée hors connexion est
 * rejouée par Background Sync, la page reçoit "gen3ia:outbox-flushed" pour
 * rafraîchir l'historique. Les échecs définitifs (session expirée, payload
 * refusé, plafond de tentatives) sont relais "gen3ia:outbox-failed" — JAMAIS
 * de perte silencieuse.
 *
 * Étape 11 — mises à jour disponibles sur TOUS les appareils : le SW
 * déployé s'active (skipWaiting côté SW) et les pages ouvertes appliquent
 * la nouvelle version au moment SÛR — onglet caché (visibilitychange) ou
 * premier controllerchange — avec un garde anti-boucle. Les sessions
 * longues (PWA laissée ouverte) re-vérifient périodiquement (30 min) et à
 * chaque retour de réseau/onglet : plus d'utilisateur bloqué sur un build
 * périmé pendant des jours.
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

    /** Recharge UNE fois la page pour appliquer la nouvelle version.
     * Le moment sûr : onglet caché (aucun travail en cours visible) — sinon
     * on signale à l'utilisateur plutôt que d'interrompre une mission. */
    const applyNewVersion = () => {
      try {
        if (sessionStorage.getItem(RELOAD_FLAG) === "1") return;
        sessionStorage.setItem(RELOAD_FLAG, "1");
      } catch {
        /* stockage indisponible : le garde est simplement absent */
      }
      if (document.visibilityState === "hidden") {
        window.location.reload();
      } else {
        // Onglet visible : on ne coupe pas une mission en cours — signal
        // doux exploitable par l'UI (bannière « nouvelle version »).
        window.dispatchEvent(new CustomEvent("gen3ia:new-version"));
      }
    };

    const checkForUpdate = () => {
      void navigator.serviceWorker.getRegistration().then((reg) => {
        // reg.waiting = un SW téléchargé PRÊT à prendre le contrôle : la
        // nouvelle version est disponible, on l'applique au moment sûr.
        if (reg?.waiting) applyNewVersion();
        void reg?.update().catch(() => undefined);
      }).catch(() => undefined);
    };

    // Un controllerchange survient AUSSI lors de la PREMIÈRE installation
    // (page initialement non contrôlée) : ce n'est PAS une mise à jour —
    // on ne recharge que si la page était DÉJÀ contrôlée (vraie reprise de
    // contrôle par un SW plus récent).
    const pageWasControlled = Boolean(navigator.serviceWorker.controller);

    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((reg) => {
      // Au retour de la connexion : demande de reprise immédiate (navigateurs
      // sans Background Sync) puis signal du retour en ligne à la page.
      window.addEventListener("online", () => {
        requestFlush(reg);
        window.dispatchEvent(new CustomEvent("gen3ia:online"));
      });
      if (navigator.onLine) requestFlush(reg);

      // Étape 11 — le nouveau SW prend le contrôle : les pages héritées
      // appliquent la version fraîche (une seule fois par session).
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (pageWasControlled) applyNewVersion();
      });
      if (reg.waiting) applyNewVersion();
    }).catch(() => {
      /* Le service worker est optionnel. */
    });

    // Étape 11 — sessions longues : re-vérification périodique, au retour
    // de l'onglet et à chaque retour de réseau.
    const pollTimer = window.setInterval(checkForUpdate, SW_UPDATE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") checkForUpdate();
    };
    document.addEventListener("visibilitychange", onVisible);

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
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(pollTimer);
    };
  }, []);

  return null;
}
