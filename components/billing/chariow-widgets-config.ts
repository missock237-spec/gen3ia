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

/**
 * Widget de RECHARGE DU WALLET API (paiement direct boutique). Hors grille
 * tarifaire : ce produit crédite le solde XAF du portefeuille — le webhook
 * Pulse reconnaît ses ventes par identifiant produit (défaut serveur
 * CHARIOW_TOPUP_PRODUCT_DEFAULT dans lib/billing/chariow.ts, surcharge
 * CHARIOW_TOPUP_PRODUCT_ID). Le produit doit être facturé en XAF côté Chariow.
 *
 * MONTANT LIBRE (choix opérateur) : le produit Chariow est configuré en prix
 * libre — c'est l'utilisateur qui choisit le montant de sa recharge sur la
 * page de paiement. Le webhook crédite le MONTANT RÉEL de la vente
 * (payload.sale.amount.value → applyTopup amountMinor), jamais un montant
 * prédéfini : aucun plafond ni palier n'est imposé par le code.
 */
export const CHARIOW_TOPUP_WIDGET: ChariowPlanWidget = {
  productId: "prd_llfosdp1",
  label: "Recharge Wallet API",
  note: "Choisis toi-même le montant de ta recharge, paie par Mobile Money ou carte — le crédit est ajouté automatiquement à ton solde après paiement (webhook Chariow)",
} as const;

/** URLs officielles du loader widget (script + feuille de style). */
export const WIDGET_SCRIPT_SRC = "https://js.chariowcdn.com/v1/widget.min.js";
export const WIDGET_STYLE_HREF = "https://js.chariowcdn.com/v1/widget.min.css";
