"use client";

import { useEffect, useRef } from "react";

/**
 * SONDAGE GATÉ PAR LA VISIBILITÉ (audit perf 2-a, lot C2).
 *
 * Les pollers côté client (suivis de run, de rendu, de sessions…) continuent
 * de frapper l'API quand l'onglet est en arrière-plan : des dizaines de
 * requêtes et de lectures Firestore pour rien. Ce hook exécute `fn` à
 * l'intervalle `ms` UNIQUEMENT quand `document.visibilityState === "visible"`,
 * et déclenche un rafraîchissement immédiat au RETOUR de visibilité
 * (visibilitychange) — l'utilisateur retrouve des données fraîches sans
 * attendre le prochain tick. `ms = null` désactive le sondage.
 *
 * La logique de pilotage (démarrage/pause/rafraîchissement) est extraite
 * dans `createVisibilityPoller` : fabrique pure, horloge et source de
 * visibilité injectées — testable sous Node sans jsdom (convention du dépôt).
 */

export type PollingCallback = () => void | Promise<void>;

export interface VisibilityPollerDeps {
  /** Intervalle entre deux exécutions (ms), strictement positif. */
  intervalMs: number;
  /** Tâche périodique (sondage). */
  fn: PollingCallback;
  /** Source de visibilité injectée (document.visibilityState en production). */
  isVisible: () => boolean;
  /** Abonnement aux changements de visibilité ; retourne la désinscription. */
  onVisibilityChange: (handler: () => void) => () => void;
  /** Horloge injectée : planification de l'intervalle. */
  schedule: (handler: () => void, ms: number) => unknown;
  /** Horloge injectée : annulation de l'intervalle. */
  cancel: (timer: unknown) => void;
}

export interface VisibilityPoller {
  /** true tant que l'intervalle tourne (onglet visible, sondage actif). */
  isRunning: () => boolean;
  /** Arrêt définitif : intervalle annulé + désabonnement visibilité. */
  stop: () => void;
}

/**
 * Fabrique PURE du poller visibilité-gaté. Comportement :
 *  - visible au démarrage  → intervalle lancé (PAS d'appel immédiat : chaque
 *    appelant conserve sa propre première interrogation) ;
 *  - caché au démarrage    → en pause ;
 *  - retour de visibilité  → appel immédiat (données fraîches) puis reprise
 *    de l'intervalle ;
 *  - passage en arrière-plan → intervalle annulé.
 */
export function createVisibilityPoller(deps: VisibilityPollerDeps): VisibilityPoller {
  const { intervalMs, fn, isVisible, onVisibilityChange, schedule, cancel } = deps;
  let timer: unknown = null;
  let stopped = false;

  const stopInterval = () => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  };

  const startInterval = () => {
    if (timer === null && !stopped) {
      timer = schedule(() => {
        void fn();
      }, intervalMs);
    }
  };

  const handleVisibilityChange = () => {
    if (stopped) return;
    if (isVisible()) {
      // Retour de visibilité : rafraîchissement immédiat puis reprise.
      void fn();
      startInterval();
    } else {
      stopInterval();
    }
  };

  if (isVisible()) startInterval();

  const unsubscribe = onVisibilityChange(handleVisibilityChange);

  return {
    isRunning: () => timer !== null,
    stop: () => {
      stopped = true;
      stopInterval();
      unsubscribe();
    },
  };
}

/**
 * Hook React : sondage visibilité-gaté. La callback est conservée par réf
 * (dernière version à chaque rendu) : l'identité du closure passé ne
 * redémarre JAMAIS l'intervalle, seul `ms` pilote le cycle de vie.
 */
export function useVisiblePolling(fn: PollingCallback, ms: number | null) {
  const fnRef = useRef<PollingCallback>(fn);
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    if (ms === null || ms <= 0) return;
    const poller = createVisibilityPoller({
      intervalMs: ms,
      fn: () => fnRef.current(),
      isVisible: () => document.visibilityState === "visible",
      onVisibilityChange: (handler) => {
        document.addEventListener("visibilitychange", handler);
        return () => document.removeEventListener("visibilitychange", handler);
      },
      schedule: (handler, interval) => window.setInterval(handler, interval),
      cancel: (timer) => window.clearInterval(timer as ReturnType<typeof window.setInterval>),
    });
    return () => poller.stop();
  }, [ms]);
}
