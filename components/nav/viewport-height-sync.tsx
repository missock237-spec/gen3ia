"use client";

import { useEffect } from "react";

/**
 * Synchronisation de la hauteur réelle de l'appareil (visualViewport).
 *
 * Les surfaces de chat plein écran (conversation, chat d'agent IA) doivent
 * occuper TOUT l'écran visible À TOUT MOMENT — y compris quand le clavier
 * virtuel est ouvert. Sur iOS, le clavier ne réduit ni 100vh ni 100dvh :
 * seul `window.visualViewport.height` reflète la zone réellement visible.
 *
 * Ce composant (sans rendu) expose cette hauteur via la variable CSS
 * `--g3-vvh` sur <html>, consommée par `.g3-shell` :
 *   height: var(--g3-vvh, 100dvh)
 *
 * Android est couvert nativement par `interactive-widget=resizes-content`
 * (voir app/layout.tsx) ; cette synchronisation ajoute iOS/Safari et fait
 * converge les deux plateformes sur le même mécanisme CSS.
 *
 * Garde anti-zoom : pendant un pinch-zoom (visualViewport.scale > 1),
 * la hauteur visuelle rétrécit sans qu'aucun clavier n'apparaisse — on
 * ignore ces mises à jour pour ne pas écraser la coquille applicative.
 */
export function ViewportHeightSync() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const root = document.documentElement;
    const apply = () => {
      if (viewport.scale > 1.05) return; // pinch-zoom actif : ne rien écraser
      root.style.setProperty("--g3-vvh", `${viewport.height}px`);
    };

    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    window.addEventListener("orientationchange", apply);

    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      window.removeEventListener("orientationchange", apply);
      root.style.removeProperty("--g3-vvh");
    };
  }, []);

  return null;
}
