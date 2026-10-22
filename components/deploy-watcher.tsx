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
 * Ce composant ferme la boucle côté produit avec DEUX sondes indépendantes
 * (plan « mise à jour forcée » 2026-10-23 : redondance — si l'une casse,
 * l'autre détecte quand même chaque déploiement) :
 * - /api/deploy-info (ultra-léger, no-store) renvoie l'empreinte du
 *   déploiement actif ;
 * - /version.json (manifeste STATIQUE écrit à chaque build, no-store +
 *   cache-buster — cf. scripts/version-manifest.mjs) renvoie la même
 *   empreinte sans passer par la couche route : un incident API/middleware
 *   n'aveugle plus la détection ;
 * - le premier relevé réussi de la page devient la RÉFÉRENCE — boucle de
 *   rechargement impossible par construction (après un reload, la référence
 *   relevée est le nouveau déploiement) ;
 * - PERSISTANCE INTER-SESSIONS (localStorage gen3ia-app-version) : si la
 *   page qui vient de se charger est PÉRIMÉE (HTML/chunks arrivés d'un
 *   cache alors que le serveur annonce une version plus récente), l'écart
 *   est détecté DÈS LE PREMIER relevé — la version nouvelle est écrite
 *   dans le stockage AVANT tout rechargement (jamais de boucle).
 * - sondage toutes les ~90 s (jitter ±25 % : les onglets ouverts ne
 *   sondent pas en vague synchronisée), + immédiatement au retour d'onglet
 *   (throttle 30 s) et au retour du réseau (événement natif online) ;
 * - écart détecté → application au moment sûr : onglet caché =
 *   rechargement transparent UNE fois par déploiement cible et par onglet
 *   (sessionStorage survit au rechargement) ; onglet visible =
 *   rechargement REPORTÉ à la prochaine mise en arrière-plan de l'onglet
 *   (invisible pour l'utilisateur — demande du 2026-10-22 : « sans même
 *   que l'utilisateur le sache ») ; filet de sécurité : si l'onglet reste
 *   au premier plan, la bannière (UpdateBanner) prend le relais après un
 *   délai avec un compte à rebours annulable.
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
/** Manifeste de version statique écrit à chaque build (scripts/
 * version-manifest.mjs) — seconde sonde indépendante de /api/deploy-info. */
const VERSION_MANIFEST_URL = "/version.json";
/** Version déjà vue par CE navigateur, persistée ENTRE les sessions : une
 * page chargée depuis un cache avec un build périmé est détectée dès le
 * premier relevé (plan de mise à jour forcée — étape 3). */
const APP_VERSION_KEY = "gen3ia-app-version";
/** Onglet resté au premier plan après détection : délai avant de laisser
 * la bannière prendre le relais (compte à rebours visible, annulable).
 * En dessous de ce délai, la nouvelle version s'applique à la première
 * mise en arrière-plan — invisible. */
const VISIBLE_DEFER_MS = 30_000;

type DeployInfo = { deploymentId?: unknown };
type VersionManifest = { version?: unknown };

export function DeployWatcher() {
  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let baseline: string | null = null;
    let lastVisibilityCheckMs = 0;
    let checkInFlight = false;
    let reloadedWithoutStorage = false;
    const notifiedTargets = new Set<string>();
    /** Cible détectée pendant que l'onglet était visible : rechargement
     * différé à la prochaine mise en arrière-plan. */
    let deferredTarget: string | null = null;
    let fallbackTimer: number | null = null;

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

    /** Seconde sonde : manifeste STATIQUE écrit à chaque build (le
     * cache-buster interdit toute réponse du cache navigateur/CDN). */
    const fetchManifestVersion = async (): Promise<string | null> => {
      try {
        const response = await fetch(`${VERSION_MANIFEST_URL}?t=${Date.now()}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        const data = (await response.json()) as VersionManifest;
        return typeof data.version === "string" && data.version.length > 0 ? data.version : null;
      } catch {
        // 404 (build antérieur au mécanisme) ou réseau : la sonde API fait foi.
        return null;
      }
    };

    /** Version déjà vue par ce navigateur (persiste entre les sessions). */
    const readStoredVersion = (): string | null => {
      try {
        return localStorage.getItem(APP_VERSION_KEY);
      } catch {
        return null; // Stockage indisponible (navigation privée stricte).
      }
    };

    /** Écrit la version AVANT tout rechargement — c'est ce qui interdit la
     * boucle : après le reload, la version servie == version stockée. */
    const storeAppVersion = (version: string): void => {
      try {
        localStorage.setItem(APP_VERSION_KEY, version);
      } catch {
        // Stockage indisponible : la garde sessionStorage canTryReload
        // et la référence relevée au chargement suivant font le reste.
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

    /** Nouveau déploiement confirmé : application au moment sûr.
     * Onglet caché → rechargement immédiat et transparent. Onglet visible
     * → rechargement REPORTÉ à la prochaine mise en arrière-plan (jamais
     * une coupure sous les yeux de l'utilisateur) ; si l'onglet reste au
     * premier plan, la bannière prend le relais après VISIBLE_DEFER_MS. */
    const applyDetectedDeployment = (id: string) => {
      if (document.visibilityState === "hidden") {
        if (canTryReload(id)) window.location.reload();
        else announceOnce(id);
        return;
      }
      if (deferredTarget !== id) {
        deferredTarget = id;
        if (fallbackTimer === null) {
          fallbackTimer = window.setTimeout(() => {
            fallbackTimer = null;
            const pending = deferredTarget;
            deferredTarget = null;
            if (pending !== null) announceOnce(pending);
          }, VISIBLE_DEFER_MS);
        }
      }
    };

    /** Signal doux UNE fois par cible — la bannière gère l'annonce et le
     * compte à rebours annulable (filet de sécurité onglet toujours au
     * premier plan). */
    const announceOnce = (id: string) => {
      if (notifiedTargets.has(id)) return;
      notifiedTargets.add(id);
      window.dispatchEvent(
        new CustomEvent("gen3ia:new-version", { detail: { deploymentId: id } }),
      );
    };

    /** L'onglet passe en arrière-plan : c'est le moment sûr — la nouvelle
     * version s'applique sans que l'utilisateur le voie. */
    const onHidden = () => {
      if (document.visibilityState !== "hidden" || deferredTarget === null) return;
      const id = deferredTarget;
      deferredTarget = null;
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (canTryReload(id)) window.location.reload();
      else announceOnce(id);
    };

    const check = async () => {
      if (disposed || checkInFlight) return;
      checkInFlight = true;
      try {
        // Les deux sondes partent en parallèle : l'API fait foi, le
        // manifeste statique prend le relais si elle est muette.
        const [apiId, manifestVersion] = await Promise.all([fetchDeploymentId(), fetchManifestVersion()]);
        if (disposed) return;
        const id = apiId ?? manifestVersion;
        if (!id) return;
        // Les deux sources répondent mais divergent : fenêtre de bascule
        // (mv→cp du swap, copie version.json vs redémarrage PM2) ou
        // rollback en cours — état AMBIGU, aucune décision ce cycle, la
        // prochaine tranchera. Jamais de rechargement sur une information
        // contradictoire.
        if (apiId !== null && manifestVersion !== null && apiId !== manifestVersion) return;
        // Premier relevé réussi = référence de la page. Ne provoque
        // JAMAIS d'application par elle-même (sinon tout onglet
        // rechargerait au démarrage) — SAUF écart inter-sessions : la
        // page qui tourne date d'un build antérieur à celui que le
        // serveur annonce (HTML/chunks servis depuis un cache) — exact
        // le cas visé par le plan de mise à jour forcée.
        if (baseline === null) {
          baseline = id;
          const stored = readStoredVersion();
          if (stored !== null && stored !== id) {
            storeAppVersion(id); // AVANT le rechargement — anti-boucle.
            applyDetectedDeployment(id);
            return;
          }
          if (stored === null) storeAppVersion(id);
          return;
        }
        if (id === baseline) return;
        baseline = id; // une seule application par déploiement cible
        storeAppVersion(id); // AVANT l'application — anti-boucle.
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
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("online", onOnline);

    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  return null;
}
