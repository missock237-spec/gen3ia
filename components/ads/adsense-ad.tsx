"use client";

import { useEffect, useRef } from "react";

/**
 * Emplacement publicitaire Google AdSense (Task 40).
 *
 * Chargé UNIQUEMENT sur les pages de contenu public (vitrine, pages
 * informatives) — jamais dans l'espace applicatif connecté (workspace,
 * conversations) : politique produits + zéro poids de bundle client sur
 * les surfaces d'exécution.
 *
 * Mécanisme : le composant pousse `{}` dans la file `window.adsbygoogle`
 * AVANT que le loader ne soit chargé — la bibliothèque AdSense consomme la
 * file à son initialisation (comportement officiel documenté), l'ordre
 * push → load est donc sûr. Le script `<ins>` reste vide (display:none)
 * tant qu'aucune annonce n'est servie : le conteneur ne réserve pas
 * d'espace fantôme côté UX.
 *
 * Config : NEXT_PUBLIC_ADSENSE_CLIENT (ca-pub-…, public par conception) +
 * slot par emplacement (NEXT_PUBLIC_ADSENSE_SLOT_HOME pour la vitrine).
 * Sans configuration, le composant ne rend RIEN (aucune régression locale).
 *
 * Loader (Task 41) : la bibliothèque adsbygoogle.js est chargée UNE SEULE
 * fois, SSR, dans le <head> du layout racine (snippet officiel de vérification
 * + Auto Ads). Ce composant n'embarque PAS de <Script> propre — le push dans
 * la file window.adsbygoogle est consommé par le loader head, quel que soit
 * l'ordre d'arrivée (file officielle, sûre dans les deux sens).
 */

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

const CLIENT_ID = process.env.NEXT_PUBLIC_ADSENSE_CLIENT?.trim();
const LOADER_SRC = CLIENT_ID
  ? `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${CLIENT_ID}`
  : undefined;

export interface AdSenseAdProps {
  /** Identifiant d'emplacement AdSense (data-ad-slot). */
  slot?: string;
  /** Format : "auto" (responsive par défaut) ou dimensions fixes. */
  format?: string;
  /** Libellé contextuel accessible (le bloc pub doit être identifiable). */
  label?: string;
  className?: string;
}

export function AdSenseAd({
  slot,
  format = "auto",
  label = "Publicité",
  className = "",
}: AdSenseAdProps) {
  const pushed = useRef(false);

  const effectiveSlot = slot?.trim() || process.env.NEXT_PUBLIC_ADSENSE_SLOT_HOME?.trim();

  useEffect(() => {
    if (!CLIENT_ID || !effectiveSlot || pushed.current) return;
    pushed.current = true;
    // File officielle AdSense : le loader consomme la pile au chargement.
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      // bloqueur de publicités ou SDK absent : silencieux par conception.
    }
  }, [effectiveSlot]);

  if (!CLIENT_ID || !effectiveSlot || !LOADER_SRC) return null;

  return (
    <aside
      className={`adsense-ad mx-auto w-full max-w-6xl px-4 sm:px-6 ${className}`}
      aria-label={label}
    >
      <p className="mb-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--g3-muted)] opacity-70">
        {label}
      </p>
      <ins
        className="adsbygoogle block"
        style={{ display: "block", minHeight: 90 }}
        data-ad-client={CLIENT_ID}
        data-ad-slot={effectiveSlot}
        data-ad-format={format}
        data-full-width-responsive="true"
      />
    </aside>
  );
}
