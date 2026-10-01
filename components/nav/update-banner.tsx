"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Bannière « mise à jour prête » — application AUTOMATIQUE de la nouvelle
 * version (Task 51, demande utilisateur explicite : « après que Vercel a
 * terminé le build, le navigateur doit charger les modifications
 * automatiquement »).
 *
 * Producteurs du signal "gen3ia:new-version" :
 * - pwa-register (étape 11) : un service worker plus récent est prêt
 *   (onglet visible) ;
 * - deploy-watcher (Task 51) : /api/deploy-info révèle un déploiement
 *   Vercel plus récent que celui au chargement de la page.
 *
 * Contrat d'application automatique (remplace le « geste explicite only »
 * de l'étape 19, évolution demandée par l'utilisateur) :
 * - COMPTE À REBOURS VISIBLE (10 s) avant rechargement — l'application ne
 *   surprend jamais : « Recharger » l'accélère, « Plus tard » l'annule ;
 * - RETENUE DE SAISIE : keydown/pointerdown récents (< 4 s) = l'utilisateur
 *   écrit ou clique — le rechargement est retenu (revérification toutes les
 *   2 s) et n'interrompt JAMAIS une saisie en cours ; l'état est annoncé à
 *   l'écran. Les missions agents s'exécutent côté serveur (reprise
 *   non-amnésique, Task 46) : un rechargement ne perd ni run ni timeline ;
 * - « Plus tard » masque l'annonce sans recharger ; elle réapparaît à la
 *   PROCHAINE détection (nouveau déploiement), jamais en boucle ;
 * - ZÉRO rendu tant qu'aucune mise à jour n'est détectée : rendu initial et
 *   hydratation intacts.
 *
 * Thème : uniquement des variables --g3-* (sombre/clair suivis exactement
 * comme le reste de l'application). Montée dans le layout racine, à côté de
 * DeployWatcher et PwaRegister — présente sur toutes les pages.
 */

/** Délai lisible avant rechargement automatique (temps de lire et annuler). */
const AUTO_RELOAD_SECONDS = 10;
/** Interaction récente : saisie en cours — le rechargement est retenu. */
const ACTIVE_GRACE_MS = 4_000;
/** Rythme de revérification pendant la retenue. */
const HOLD_CHECK_MS = 2_000;

export function UpdateBanner() {
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [remaining, setRemaining] = useState(AUTO_RELOAD_SECONDS);
  const [holding, setHolding] = useState(false);
  const lastInteractionAtRef = useRef(0);

  // Suivi d'interaction (capture + passive : jamais de blocage du rendu ni
  // de geste) : la bannière sait si une saisie est en cours et RETIENT le
  // rechargement automatique au lieu de couper l'utilisateur à la frappe.
  useEffect(() => {
    const markInteraction = () => {
      lastInteractionAtRef.current = Date.now();
    };
    window.addEventListener("keydown", markInteraction, { capture: true, passive: true });
    window.addEventListener("pointerdown", markInteraction, { capture: true, passive: true });
    return () => {
      window.removeEventListener("keydown", markInteraction, { capture: true });
      window.removeEventListener("pointerdown", markInteraction, { capture: true });
    };
  }, []);

  useEffect(() => {
    const onNewVersion = () => {
      // Nouvelle détection : l'annonce réapparaît (elle avait pu être
      // masquée pour le déploiement PRÉCÉDENT) et le compte à rebours repart.
      setAvailable(true);
      setDismissed(false);
    };
    window.addEventListener("gen3ia:new-version", onNewVersion);
    return () => window.removeEventListener("gen3ia:new-version", onNewVersion);
  }, []);

  // Compte à rebours → rechargement automatique au terme, sauf annulation
  // (« Plus tard » démonte l'effet via dismissed) ou saisie en cours
  // (retenue sans expiration forcée : on ne coupe jamais une frappe).
  useEffect(() => {
    if (!available || dismissed) return;
    let timer: number | null = null;
    let deadline = Date.now() + AUTO_RELOAD_SECONDS * 1000;
    setRemaining(AUTO_RELOAD_SECONDS);
    setHolding(false);

    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };

    const tick = () => {
      const leftMs = deadline - Date.now();
      if (leftMs > 0) {
        setRemaining(Math.max(1, Math.ceil(leftMs / 1000)));
        return;
      }
      // Échéance atteinte : retenu si l'utilisateur interagit encore.
      if (Date.now() - lastInteractionAtRef.current < ACTIVE_GRACE_MS) {
        setHolding(true);
        deadline = Date.now() + HOLD_CHECK_MS;
        return;
      }
      stop();
      window.location.reload();
    };

    timer = window.setInterval(tick, 1000);
    return stop;
  }, [available, dismissed]);

  // Aucun rendu tant qu'aucune mise à jour n'est détectée (et après
  // « Plus tard ») : zéro impact sur le rendu initial et sur l'hydratation.
  if (!available || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="anim-scale-in fixed left-1/2 top-3 z-[110] w-[min(26rem,calc(100vw-1.5rem))] -translate-x-1/2"
    >
      <div className="g3-card flex items-center gap-3 rounded-2xl border border-[rgba(23,23,20,0.1)] px-4 py-3 shadow-[0_14px_36px_-16px_rgba(28,27,24,0.45)]">
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--g3-primary-soft,rgba(124,92,255,0.14))] text-sm text-[var(--g3-primary,#7C5CFF)]"
        >
          ✦
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-tight text-[var(--g3-text)]">
            Mise à jour prête
          </p>
          {holding ? (
            <p className="mt-0.5 text-xs leading-snug text-[var(--g3-muted)]">
              Rechargement dès la fin de votre saisie — rien n&apos;est interrompu.
            </p>
          ) : (
            <p className="mt-0.5 text-xs leading-snug text-[var(--g3-muted)]">
              Rechargement automatique dans{" "}
              <span
                aria-hidden
                className="font-semibold tabular-nums text-[var(--g3-text)]"
              >
                {remaining} s
              </span>{" "}
              — « Plus tard » pour annuler.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="g3-btn g3-btn-primary shrink-0 rounded-full px-3.5 py-1.5 text-xs"
        >
          Recharger
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Annuler le rechargement automatique"
          className="shrink-0 rounded p-1 text-[var(--g3-faint)] transition-colors hover:text-[var(--g3-text-secondary)]"
        >
          <span aria-hidden>✕</span>
        </button>
      </div>
    </div>
  );
}
