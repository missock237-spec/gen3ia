/**
 * CONFIGURATION DES WIDGETS DE PAIEMENT DIRECT CHARIOW (données pures).
 *
 * Module importable côté client ET côté tests (aucune API DOM, aucun secret —
 * les identifiants produits sont publics : ils figurent dans le code d'embed
 * officiel de la boutique). La source de vérité serveur reste
 * lib/billing/plans.ts ; ce fichier reflète les produits publiés et sert au
 * rendu des widgets sur /billing.
 */

/** Boutique Chariow officielle Gen3ia (data-store-domain du code d'embed). */
export const CHARIOW_STORE_DOMAIN = "xdaagetk.mychariow.shop";

/** Les 3 produits payants de la grille, prêts pour le paiement direct. */
export interface ChariowPlanWidget {
  productId: string;
  label: string;
  note: string;
}

export const CHARIOW_PLAN_WIDGETS: readonly ChariowPlanWidget[] = [
  {
    productId: "prd_svqonju7",
    label: "Plan Pro — 9 750 FCFA",
    note: "Agent Master, priorité P2P, RAG chiffré, API datasets",
  },
  {
    productId: "prd_v76f5kjl",
    label: "Plan Entreprise — 325 000 FCFA",
    note: "Private Mesh, confidentialité totale, multi-postes",
  },
  {
    productId: "prd_646qpmge",
    label: "Modèle Sur-Mesure — 995 000 FCFA",
    note: "Arène d'Ondes, modèle dédié livré en paquet d'ondes",
  },
] as const;

/** URLs officielles du loader widget (script + feuille de style). */
export const WIDGET_SCRIPT_SRC = "https://js.chariowcdn.com/v1/widget.min.js";
export const WIDGET_STYLE_HREF = "https://js.chariowcdn.com/v1/widget.min.css";
