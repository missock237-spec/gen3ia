"use client";

import React from "react";

import { deriveStatutApplication, libelleDerniereVerification, type StatutApplication } from "@/lib/app/statut-app";

/**
 * STATUT DE MISE À JOUR AUTOMATIQUE — visible dans la section « Application »
 * des Paramètres. La demande utilisateur : l'app téléchargée est CONNECTÉE
 * à la version site web et « lors d'une mise à jour la version app se met
 * à jour automatiquement ». Ce composant rend cette garantie VISIBLE :
 *  · la version active servie par le site (/api/deploy-info + /version.json
 *    — les deux mêmes sondes que le DeployWatcher) ;
 *  · la version enregistrée par ce navigateur (localStorage
 *    gen3ia-app-version — écrit par le watcher AVANT tout rechargement) ;
 *  · l'état dérivé : à jour ✓ / nouvelle version en application
 *    automatique / vérification indisponible ;
 *  · un bouton « Vérifier maintenant » qui pousse le service worker à
 *    re-sonder immédiatement (reg.update()) puis relit les sondes.
 *
 * Aucun rendu serveur : tout l'état vient du navigateur réel.
 */

const TIMEOUT_SONDE_MS = 8000;

async function lireEmpreinteSonde(url: string): Promise<string | null> {
  try {
    const reponse = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_SONDE_MS) });
    if (!reponse.ok) return null;
    const data = (await reponse.json()) as { deploymentId?: unknown; version?: unknown };
    const valeur = data.deploymentId ?? data.version;
    return typeof valeur === "string" && valeur.length > 0 ? valeur : null;
  } catch {
    return null; // hors-ligne / incident : l'état devient « indéterminé »
  }
}

function lireVersionLocale(): string | null {
  try {
    return localStorage.getItem("gen3ia-app-version");
  } catch {
    return null; // stockage indisponible (navigation privée stricte)
  }
}

export function PwaUpdateStatus() {
  const [statut, setStatut] = React.useState<StatutApplication | null>(null);
  const [derniereVerifMs, setDerniereVerifMs] = React.useState<number | null>(null);
  const [verifieMaintenant, setVerifieMaintenant] = React.useState(false);

  const verifier = React.useCallback(async (forcerServiceWorker: boolean) => {
    setVerifieMaintenant(true);
    try {
      // Le service worker re-sonde sw.js (nouveau déploiement téléchargé et
      // pris en contrôle via skipWaiting) — la même commande que le watcher.
      if (forcerServiceWorker && "serviceWorker" in navigator) {
        void navigator.serviceWorker.getRegistration().then((reg) => {
          void reg?.update().catch(() => undefined);
        }).catch(() => undefined);
      }
      // Les deux sondes partent en parallèle (même règle que le watcher :
      // l'API fait foi, le manifeste statique prend le relais).
      const [apiId, manifestVersion] = await Promise.all([
        lireEmpreinteSonde("/api/deploy-info"),
        lireEmpreinteSonde(`/version.json?t=${Date.now()}`),
      ]);
      setStatut(
        deriveStatutApplication({
          apiId,
          manifestVersion,
          versionLocale: lireVersionLocale(),
          nouvelleVersionEnAttente: false,
        }),
      );
      setDerniereVerifMs(Date.now());
    } finally {
      setVerifieMaintenant(false);
    }
  }, []);

  React.useEffect(() => {
    void verifier(false);
    // Re-vérification au retour d'onglet / réseau (léger : deux fetch).
    const onVisible = () => {
      if (document.visibilityState === "visible") void verifier(false);
    };
    const onOnline = () => void verifier(false);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [verifier]);

  return (
    <div className="mt-4 rounded-2xl bg-[var(--g3-elevated)]/60 p-4" aria-labelledby="pwa-update-status-title">
      <p id="pwa-update-status-title" className="text-sm font-semibold text-[var(--g3-text)]">
        Mises à jour automatiques : activées ✓
      </p>
      <p className="mt-1.5 text-sm leading-6 text-[var(--g3-muted)]" role="status" aria-live="polite">
        {statut ? (
          <>
            <span
              className={
                statut.etat === "a-jour"
                  ? "font-semibold text-[var(--g3-success-strong)]"
                  : statut.etat === "nouvelle-version"
                    ? "font-semibold text-[var(--g3-primary)]"
                    : "font-semibold text-[var(--g3-text-secondary)]"
              }
            >
              {statut.libelle}
            </span>
            {statut.versionActive ? (
              <span className="ml-1">
                — version <code className="text-xs">{statut.versionActive.slice(0, 12)}</code>
              </span>
            ) : null}
            <span className="mt-1 block">{statut.detail}</span>
            <span className="mt-1 block text-xs text-[var(--g3-faint)]">
              Dernière vérification : {libelleDerniereVerification(derniereVerifMs, Date.now())}.
            </span>
          </>
        ) : (
          <span className="font-semibold text-[var(--g3-text-secondary)]">Vérification en cours…</span>
        )}
      </p>
      <button
        type="button"
        className="mt-3 inline-flex items-center gap-2 rounded-full border border-[var(--g3-primary-border)] bg-[var(--g3-primary-soft)] px-4 py-2 text-sm font-semibold text-[var(--g3-text)] transition hover:border-[var(--g3-primary)] disabled:opacity-60"
        onClick={() => void verifier(true)}
        disabled={verifieMaintenant}
      >
        {verifieMaintenant ? "Vérification…" : "Vérifier maintenant"}
      </button>
    </div>
  );
}
