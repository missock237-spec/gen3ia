/**
 * Catalogue des offres Gen3ia (grille tarifaire officielle Chariow).
 *
 * Quatre offres pilotent l'accès aux fonctionnalités :
 *  - gratuit          : 0 €            — micro-agents standards, essaim P2P public.
 *  - pro              : 15 € / mois    — Agent Master, priorité P2P, RAG chiffré, API datasets.
 *  - entreprise       : 325 000 FCFA (≈ 495 €) — mesh privé (IA 100 % locale), multi-postes, support prioritaire.
 *  - modele-sur-mesure: 995 000 FCFA (≈ 1 517 €) — entraînement d'un modèle dédié dans l'Arène d'Ondes,
 *                                       livré en paquet d'ondes autonome.
 *
 * La devise de la boutique Chariow est le XAF (parité fixe : 1 EUR = 655.957 XAF),
 * identique au wallet (lib/billing/wallet.ts). Les prix affichés sont ALIGNÉS sur
 * les produits réellement publiés dans la boutique (source de vérité du paiement :
 * le checkout Chariow facture le prix du produit, jamais ce fichier). Les
 * identifiants produits restent surchargeables par CHARIOW_PLAN_<PLAN>_PRODUCT_ID
 * (env) ; à défaut chaque plan tombe sur son produit boutique par défaut :
 *  - pro            → prd_svqonju7 (« Plan pro », 9 750 XAF)
 *  - entreprise     → prd_v76f5kjl (« Plan entreprise », 325 000 XAF)
 *  - sur-mesure     → prd_646qpmge (« Entraînez vos modèles d'IA », 995 000 XAF)
 *
 * Les trois produits boutique sont des licences one_time : l'accès Pro/Entreprise
 * est accordé 30 jours par licence achetée (renouvelable), le sur-mesure sans
 * expiration. Les 3 widgets de paiement direct (boutique Chariow) sont rendus
 * sur /billing par components/billing/chariow-widget.tsx ; une licence achetée
 * hors plateforme s'active via POST /api/billing/plans/licence.
 */

/** Taux EUR → XAF (parité fixe du franc CFA). Surchargeable via CHARIOW_EUR_XAF_RATE. */
export const EUR_XAF_RATE = (() => {
  const parsed = Number(process.env.CHARIOW_EUR_XAF_RATE);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 655.957;
})();

/** Identifiant interne d'un plan. */
export type PlanId = "gratuit" | "pro" | "entreprise" | "modele-sur-mesure";

/** Fonctionnalités gated par abonnement (lib/billing/abonnements.ts fait respecter). */
export type PlanEntitlement =
  | "micro_agents"
  | "agent_master"
  | "apprentissage_modules"
  | "p2p_priority"
  | "rag_chiffre"
  | "datasets_api"
  /** Demande utilisateur n°8 : création de clés API entreprise (`g3a_`) réservée au plan Pro ou supérieur. */
  | "api_keys"
  | "private_mesh"
  | "multi_postes"
  | "support_prioritaire"
  | "arene_ondes"
  | "paquet_ondes";

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Prix affiché en euros (grille commerciale). */
  priceEur: number;
  /** Prix facturé en XAF (devise de la boutique et du wallet), unités entières. */
  priceXaf: number;
  /** Périodicité de facturation : mensuel, unique (à l'unité) ou gratuit. */
  cycle: "gratuit" | "mensuel" | "unique";
  /** Durée d'accès accordée après paiement, en jours (null = sans expiration). */
  accessDays: number | null;
  /** Variable d'environnement du produit Chariow (licence) correspondant. */
  productIdEnv: string;
  /** Produit déjà créé dans la boutique Chariow (fallback de configuration). */
  defaultProductId: string | null;
  /** Fonctionnalités incluses. */
  entitlements: PlanEntitlement[];
  /** Public cible (carte tarifaire). */
  audience: string;
  /** Points d'accès affichés sur la carte tarifaire. */
  features: string[];
  highlight: boolean;
}

// Produits Chariow réellement publiés dans la boutique (vérifiés via
// GET /products — scripts/chariow_plans_status.mjs). Le dashboard Chariow
// reste la seule voie de création/modification ; ces constantes sont les
// replis par défaut, la variable d'environnement prime toujours.
const PRO_PRODUCT_ID = "prd_svqonju7";
const ENTREPRISE_PRODUCT_ID = "prd_v76f5kjl";
const SUR_MESURE_PRODUCT_ID = "prd_646qpmge";

export const PLANS: Record<PlanId, PlanDefinition> = {
  gratuit: {
    id: "gratuit",
    name: "Plan Gratuit",
    priceEur: 0,
    priceXaf: 0,
    cycle: "gratuit",
    accessDays: null,
    productIdEnv: "CHARIOW_PLAN_GRATUIT_PRODUCT_ID",
    defaultProductId: null,
    entitlements: ["micro_agents"],
    audience: "Grand public, curieux, étudiants",
    features: [
      "Accès aux micro-agents standards",
      "Inférence de base via l'essaim P2P public",
      "Contribution passive au réseau (donnant-donnant)",
    ],
    highlight: false,
  },
  pro: {
    id: "pro",
    name: "Plan Pro",
    priceEur: 15,
    priceXaf: 9750,
    cycle: "mensuel",
    accessDays: 30,
    productIdEnv: "CHARIOW_PLAN_PRO_PRODUCT_ID",
    defaultProductId: PRO_PRODUCT_ID,
    entitlements: [
      "micro_agents",
      "agent_master",
      "apprentissage_modules",
      "p2p_priority",
      "rag_chiffre",
      "datasets_api",
      "api_keys",
    ],
    audience: "Développeurs, créateurs, freelances",
    features: [
      "Accès complet à l'Agent Master et aux modules d'apprentissage",
      "Priorité de calcul sur l'essaim P2P",
      "RAG local chiffré et intégration d'API de datasets",
      "Création de clés API (usage facturé : 1,00 €/1M tokens entrant, 1,50 €/1M sortant)",
    ],
    highlight: true,
  },
  entreprise: {
    id: "entreprise",
    name: "Plan Entreprise",
    // Prix du produit boutique « Plan entreprise » (prd_v76f5kjl) : 325 000 XAF.
    priceEur: 495,
    priceXaf: 325000,
    cycle: "mensuel",
    accessDays: 30,
    productIdEnv: "CHARIOW_PLAN_ENTREPRISE_PRODUCT_ID",
    defaultProductId: ENTREPRISE_PRODUCT_ID,
    entitlements: [
      "micro_agents",
      "agent_master",
      "apprentissage_modules",
      "p2p_priority",
      "rag_chiffre",
      "datasets_api",
      "api_keys",
      "private_mesh",
      "multi_postes",
      "support_prioritaire",
    ],
    audience: "TPE / PME, cabinets, structures locales",
    features: [
      "IA 100 % locale et décentralisée (Private Mesh)",
      "Confiance et confidentialité totale (aucune donnée ne sort du parc informatique)",
      "Support prioritaire et clé de licence multi-postes",
    ],
    highlight: false,
  },
  "modele-sur-mesure": {
    id: "modele-sur-mesure",
    name: "Modèle Sur-Mesure",
    // Prix du produit boutique « Entraînez vos modèles d'IA » (prd_646qpmge) : 995 000 XAF.
    priceEur: 1517,
    priceXaf: 995000,
    cycle: "unique",
    accessDays: null,
    productIdEnv: "CHARIOW_PLAN_SUR_MESURE_PRODUCT_ID",
    defaultProductId: SUR_MESURE_PRODUCT_ID,
    entitlements: [
      "micro_agents",
      "agent_master",
      "apprentissage_modules",
      "p2p_priority",
      "rag_chiffre",
      "datasets_api",
      "api_keys",
      "private_mesh",
      "multi_postes",
      "support_prioritaire",
      "arene_ondes",
      "paquet_ondes",
    ],
    audience: "PME / Grands Groupes, chercheurs, labos",
    features: [
      "Entraînement complet d'un modèle/agent dédié dans l'Arène Virtuelle d'Ondes",
      "Traduction et correction symbolique sur-mesure pour vos besoins métiers",
      "Livré clé en main sous forme de paquet d'ondes autonome optimisé",
    ],
    highlight: false,
  },
};

export const PLAN_ORDER: readonly PlanId[] = ["gratuit", "pro", "entreprise", "modele-sur-mesure"];

/** Équivalent XAF arrondi d'un prix EUR (parité fixe, borné aux dizaines). */
export function eurToXaf(eur: number): number {
  return Math.round((eur * EUR_XAF_RATE) / 10) * 10;
}

/** Résout l'identifiant produit Chariow d'un plan (env → fallback boutique). */
export function resolvePlanProductId(plan: PlanId): string | null {
  const definition = PLANS[plan];
  const configured = process.env[definition.productIdEnv]?.trim();
  if (configured) return configured;
  return definition.defaultProductId;
}

/** Vérifie qu'un identifiant de plan connu a bien été passé (entrée utilisateur). */
export function isKnownPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PLANS, value);
}

/** Libellé prix affichable : « 9 750 FCFA (15 €) / mois ». */
export function formatPlanPrice(plan: PlanId): string {
  const definition = PLANS[plan];
  if (definition.priceXaf === 0) return "0 FCFA";
  // toLocaleString("fr-FR") insère des espaces fines insécables (U+202F/U+00A0)
  // selon la version d'ICU : normalisées en espaces simples pour un rendu
  // stable entre navigateurs et serveur (testés).
  const eur = definition.priceEur.toLocaleString("fr-FR", { maximumFractionDigits: 2 }).replace(/[\u202F\u00A0]/g, " ");
  const xaf = definition.priceXaf.toLocaleString("fr-FR").replace(/[\u202F\u00A0]/g, " ");
  const suffix = definition.cycle === "mensuel" ? " / mois" : definition.cycle === "unique" ? " / modèle" : "";
  return `${xaf} FCFA (${eur} €)${suffix}`;
}

/** Formulaire public (sans secret) sérialisable vers l'UI /billing. */
export interface PublicPlan {
  id: PlanId;
  name: string;
  priceLabel: string;
  cycle: PlanDefinition["cycle"];
  audience: string;
  features: string[];
  highlight: boolean;
  /** false tant que le produit Chariow n'est pas configuré → carte consultable seulement. */
  purchasable: boolean;
  current: boolean;
}

export function toPublicPlan(plan: PlanId, activePlan: PlanId | null): PublicPlan {
  const definition = PLANS[plan];
  return {
    id: plan,
    name: definition.name,
    priceLabel: formatPlanPrice(plan),
    cycle: definition.cycle,
    audience: definition.audience,
    features: definition.features,
    highlight: definition.highlight,
    purchasable: plan === "gratuit" || resolvePlanProductId(plan) != null,
    current: activePlan === plan,
  };
}

/**
 * Métadonnées Chariow apposées à chaque visite de paiement créée par la
 * plateforme : le webhook Pulse identifie la vente comme un abonnement Gen3ia
 * (gen3ia_product = plan_subscription) et connaît le plan acheté + l'utilisateur
 * initiateur — Chariow sait ainsi que la session provient bien de la plateforme.
 */
export function planCheckoutMetadata(plan: PlanId, userId: string): Record<string, string> {
  return {
    gen3ia_product: "plan_subscription",
    plan_id: plan,
    user_id: userId.slice(0, 255),
  };
}
