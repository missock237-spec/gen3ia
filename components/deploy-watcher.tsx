"use client";

import { useEffect } from "react";

/**
 * Veille de déploiement — rechargement automatique après chaque build
 * Vercel (Task 51, demande utilisateur explicite : « après que Vercel a
 * terminé le build, le navigateur doit charger les modifications
 * automatiquement »).
 *
 * Le couple pwa-register/sw.js (étapes 11/19) ne détecte une mise à jour
 * qu'aux moments où le NAVIGATEUR revalide sw.js : navigation, retour
 * d'onglet, ou sondage toutes les 30 min. Un onglet ouvert et inactif
 * restait donc sur un build périmé jusqu'à 30 minutes après la fin d'un
 * build Vercel — et l'application ne dépassait jamais la bannière manuelle.
 *
 * Ce composant ferme la boucle côté produit :
 * - /api/deploy-info (ultra-léger, no-store) renvoie l'empreinte du
 *   déploiement actif ; le premier relevé réussi de la page devient la
 *   RÉFÉRENCE — boucle de rechargement impossible par construction (après
 *   un reload, la référence relevée est le nouveau déploiement) ;
 * - sondage toutes les ~90 s (jitter ±25 % : les onglets ouverts ne
 *   sondent pas en vague synchronisée), + immédiatement au retour d'onglet
 *   (throttle 30 s) et au retour du réseau (événement natif online) ;
 * - écart détecté → application au moment sûr : onglet caché =
 *   rechargement transparent UNE fois par déploiement cible et par onglet
 *   (sessionStorage survit au rechargement) ; onglet visible ou repli =
 *   signal "gen3ia:new-version" une seule fois par cible — la bannière
 *   (UpdateBanner) prend le relais avec un compte à rebours annulable.
 *
 * Échec réseau / hors-ligne : la sonde est silencieusement ignorée, le
 * prochain cycle retentera — jamais de rechargement en boucle hors-ligne.
 * Aucun rendu : logique 100 % effet, hydratation intacte.
 */

/** Période de base entre deux sondes du déploiement actif. */
const DEPLOY_POLL_MS = 90_000;
/** Jitter relatif (±25 %) : désynchronise les onglets ouverts. */
const DEPLOY_POLL_JITTER = 0.25;
/** Throttle du déclencheur « retour d'onglet » : au plus une sonde / 30 s. */
const VISIBILITY_MIN_GAP_MS = 30_000;
/** Délai d'abandon d'une sonde réseau pendue (AbortSignal.timeout). */
const POLL_TIMEOUT_MS = 10_000;
/** Garde anti-boucle PAR CIBLE : un rechargement automatique maximum par
 * déploiement détecté et par onglet (sessionStorage survit au reload). */
const RELOAD_FLAG_PREFIX = "gen3ia-deploy-reloaded:";

type DeployInfo = { deploymentId?: unknown };

export function DeployWatcher() {
  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let baseline: string | null = null;
    let lastVisibilityCheckMs = 0;
    let checkInFlight = false;
    let reloadedWithoutStorage = false;
    const notifiedTargets = new Set<string>();

    const fetchDeploymentId = async (): Promise<string | null> => {
      try {
        const response = await fetch("/api/deploy-info", {
          cache: "no-store",
          signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        const data = (await response.json()) as DeployInfo;
        return typeof data.deploymentId === "string" && data.deploymentId.length > 0
          ? data.deploymentId
          : null;
      } catch {
        // Hors-ligne, réseau instable, sonde pendue : réessai au prochain cycle.
        return null;
      }
    };

    /** Droit de rechargement automatique pour cette cible : gardé par
     * sessionStorage quand il est disponible (survit au reload — c'est lui
     * qui interdit la boucle), sinon par garde en mémoire de secours. */
    const canTryReload = (id: string): boolean => {
      try {
        const flagKey = RELOAD_FLAG_PREFIX + id;
        if (sessionStorage.getItem(flagKey) === "1") return false;
        sessionStorage.setItem(flagKey, "1");
        return true;
      } catch {
        // Stockage indisponible (navigation privée stricte) : au plus un
        // rechargement par chargement de page — la référence relevée au
        // chargement suivant fait le reste.
        if (reloadedWithoutStorage) return false;
        reloadedWithoutStorage = true;
        return true;
      }
    };

    /** Nouveau déploiement confirmé : application au moment sûr. */
    const applyDetectedDeployment = (id: string) => {
      if (document.visibilityState === "hidden" && canTryReload(id)) {
        window.location.reload();
        return;
      }
      // Onglet visible (ou rechargement déjà tenté pour cette cible) :
      // signal doux UNE fois par cible — la bannière gère l'annonce et le
      // compte à rebours annulable.
      if (!notifiedTargets.has(id)) {
        notifiedTargets.add(id);
        window.dispatchEvent(
          new CustomEvent("gen3ia:new-version", { detail: { deploymentId: id } }),
        );
      }
    };

    const check = async () => {
      if (disposed || checkInFlight) return;
      checkInFlight = true;
      try {
        const id = await fetchDeploymentId();
        if (disposed || !id) return;
        // Premier relevé réussi = référence de la page : ne provoque JAMAIS
        // d'application (sinon tout onglet rechargerait au démarrage).
        if (baseline === null) {
          baseline = id;
          return;
        }
        if (id === baseline) return;
        baseline = id; // une seule application par déploiement cible
        applyDetectedDeployment(id);
      } finally {
        checkInFlight = false;
      }
    };

    const schedule = () => {
      if (disposed) return;
      const jitter = 1 + (Math.random() * 2 - 1) * DEPLOY_POLL_JITTER;
      timer = window.setTimeout(() => {
        void check().finally(schedule);
      }, Math.round(DEPLOY_POLL_MS * jitter));
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastVisibilityCheckMs < VISIBILITY_MIN_GAP_MS) return;
      lastVisibilityCheckMs = now;
      void check();
    };

    // Événement NATIF (indépendant de pwa-register) : au retour du réseau,
    // on revérifie tout de suite — un onglet resté hors-ligne pendant le
    // build rattrape le déploiement sans attendre le prochain cycle.
    const onOnline = () => {
      void check();
    };

    void check();
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);

    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  return null;
}
