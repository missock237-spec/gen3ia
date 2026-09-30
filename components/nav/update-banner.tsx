"use client";

import { useEffect, useState } from "react";

/**
 * Bannière « nouvelle version » (étape 19 — performance/UX ; complète l'étape 11).
 *
 * pwa-register détecte les mises à jour du service worker et applique la
 * nouvelle version au moment SÛR : onglet caché → rechargement transparent ;
 * onglet VISIBLE → signal doux "gen3ia:new-version" pour ne JAMAIS couper une
 * mission en cours. Ce signal était prêt mais ORPHELIN : l'utilisateur d'un
 * onglet visible (ou d'une PWA installée laissée ouverte) restait sans aucun
 * retour et découvrait la nouvelle version des jours plus tard — exactement
 * le scénario que l'audit de production demande de fermer (« alertes
 * d'invalidation de cache PWA pour forcer le rechargement transparent sans
 * interrompre une mission en cours »).
 *
 * Cette bannière consomme le signal : un pill discret en haut de l'écran.
 * « Recharger » applique la version immédiatement (le garde anti-boucle de
 * session de pwa-register interdit toute boucle de rechargement) ; « Plus
 * tard » masque l'annonce — elle réapparaîtra à la PROCHAINE détection de
 * mise à jour, jamais en boucle. La bannière ne recharge JAMAIS d'elle-même :
 * seul un geste utilisateur explicite interrompt la session visible.
 *
 * Thème : uniquement des variables --g3-* (sombre/clair suivis exactement
 * comme le reste de l'application). Montée dans le layout racine, à côté de
 * PwaRegister — présente sur toutes les pages.
 */
export function UpdateBanner() {
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const onNewVersion = () => setAvailable(true);
    window.addEventListener("gen3ia:new-version", onNewVersion);
    return () => window.removeEventListener("gen3ia:new-version", onNewVersion);
  }, []);

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
            Nouvelle version disponible
          </p>
          <p className="mt-0.5 text-xs leading-snug text-[var(--g3-muted)]">
            Rechargez pour l&apos;appliquer — votre travail en cours n&apos;est pas interrompu.
          </p>
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
          aria-label="Masquer cette annonce"
          className="shrink-0 rounded p-1 text-[var(--g3-faint)] transition-colors hover:text-[var(--g3-text-secondary)]"
        >
          <span aria-hidden>✕</span>
        </button>
      </div>
    </div>
  );
}
