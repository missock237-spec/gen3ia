"use client";

import { useEffect } from "react";

import {
  CHARIOW_STORE_DOMAIN,
  WIDGET_SCRIPT_SRC,
  WIDGET_STYLE_HREF,
} from "./chariow-widgets-config";

export { CHARIOW_PLAN_WIDGETS, CHARIOW_STORE_DOMAIN, CHARIOW_TOPUP_WIDGET } from "./chariow-widgets-config";

/**
 * WIDGET DE PAIEMENT DIRECT CHARIOW (boutique officielle).
 *
 * Rend le bouton « tap » Chariow d'un produit de la grille tarifaire : le
 * clic ouvre le checkout de la boutique (xdaagetk.mychariow.shop) dans une
 * iframe/redirect gérée par le script officiel js.chariowcdn.com. La licence
 * reçue après paiement s'active sur /billing via POST /api/billing/plans/licence
 * (le webhook Pulse crédite aussi automatiquement les ventes reconnues).
 *
 * Fonctionnement du script Chariow (widget.min.js v1) : au chargement, il
 * scanne UNE SEULE FOIS tous les éléments `#chariow-widget` du document
 * (querySelectorAll) et y rend le bouton. Conséquences câblées ici :
 *  - l'injection se fait APRÈS le rendu des divs (useEffect), dédoublonnée
 *    par micro-tâche pour que N widgets montés au même commit ne provoquent
 *    qu'un seul chargement de script (tous les divs existent déjà) ;
 *  - au REMONTAGE React (navigation client, retour sur /billing), le script
 *    est déjà présent mais son scan a déjà eu lieu → on le retire et on le
 *    réinjecte pour forcer un nouveau scan des divs fraîchement montés
 *    (le navigateur sert le fichier depuis son cache HTTP).
 *
 * Les identifiants produits vivent dans chariow-widgets-config.ts (données
 * pures, testables) ; la source de vérité serveur reste lib/billing/plans.ts.
 */

const WIDGET_SCRIPT_ID = "chariow-widget-loader";
const WIDGET_STYLE_ID = "chariow-widget-style";

/** Injections planifiées en cours (un seul re-scan pour N widgets montés). */
let injectionProgrammee: ReturnType<typeof setTimeout> | null = null;

function injecterStyleUnique(): void {
  if (document.getElementById(WIDGET_STYLE_ID)) return;
  const link = document.createElement("link");
  link.id = WIDGET_STYLE_ID;
  link.rel = "stylesheet";
  link.href = WIDGET_STYLE_HREF;
  document.head.appendChild(link);
}

function injecterScriptWidget(): void {
  injecterStyleUnique();
  // Re-scan forcé : retirer le script existant (le recharger re-exécute le
  // scan `document.querySelectorAll("#chariow-widget")` sur le DOM courant).
  document.getElementById(WIDGET_SCRIPT_ID)?.remove();
  const script = document.createElement("script");
  script.id = WIDGET_SCRIPT_ID;
  script.src = WIDGET_SCRIPT_SRC;
  script.async = true;
  document.head.appendChild(script);
}

function programmerInjection(): void {
  if (injectionProgrammee) return;
  // Micro-délai : laisse tous les widgets du même commit finir de monter,
  // puis UN seul chargement/re-scan couvre l'ensemble des divs présents.
  injectionProgrammee = setTimeout(() => {
    injectionProgrammee = null;
    injecterScriptWidget();
  }, 0);
}

export interface ChariowWidgetProps {
  /** Identifiant produit Chariow (ex. prd_svqonju7). */
  productId: string;
  /** Domaine de la boutique (défaut : boutique officielle Gen3ia). */
  storeDomain?: string;
}

export default function ChariowWidget({ productId, storeDomain = CHARIOW_STORE_DOMAIN }: ChariowWidgetProps) {
  useEffect(() => {
    programmerInjection();
    return () => {
      if (injectionProgrammee) {
        clearTimeout(injectionProgrammee);
        injectionProgrammee = null;
      }
    };
  }, [productId]);

  return (
    <div
      id="chariow-widget"
      data-product-id={productId}
      data-store-domain={storeDomain}
      data-style="tap"
      data-border-style="rounded"
      data-cta-width="xs"
      data-background-color="#FFFFFF"
      data-cta-animation="shine"
      data-locale="fr"
      data-primary-color="#ffcc00"
    />
  );
}
