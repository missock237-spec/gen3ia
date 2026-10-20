import { describe, expect, it } from "vitest";

import {
  EUR_XAF_RATE,
  PLAN_ORDER,
  PLANS,
  eurToXaf,
  formatPlanPrice,
  isKnownPlanId,
  planCheckoutMetadata,
  resolvePlanProductId,
  toPublicPlan,
  type PlanEntitlement,
} from "./plans";

/**
 * Grille tarifaire officielle Gen3ia (Chariow) : 4 offres — Gratuit 0 €,
 * Pro 15 €/mois, Entreprise 500 €/mois, Modèle Sur-Mesure 5 000 €/modèle.
 * La devise facturée est le XAF (parité fixe 1 EUR = 655.957 XAF), la même
 * que le wallet ; les entitlemements s'emboîtent (chaque plan inclut tous
 * les droits des plans inférieurs).
 */

describe("grille tarifaire (prix boutique Chariow)", () => {
  it("couvre exactement les 4 offres dans l'ordre d'affichage", () => {
    expect(PLAN_ORDER).toEqual(["gratuit", "pro", "entreprise", "modele-sur-mesure"]);
  });

  it("facture les prix XAF de la grille (0 / 9 750 / 328 000 / 3 280 000 FCFA)", () => {
    expect(PLANS.gratuit.priceXaf).toBe(0);
    expect(PLANS.pro.priceXaf).toBe(9750);
    expect(PLANS.entreprise.priceXaf).toBe(328000);
    expect(PLANS["modele-sur-mesure"].priceXaf).toBe(3280000);
  });

  it("correspond aux tarifs EUR annoncés (0 / 15 / 500 / 5000 €)", () => {
    expect(PLANS.gratuit.priceEur).toBe(0);
    expect(PLANS.pro.priceEur).toBe(15);
    expect(PLANS.entreprise.priceEur).toBe(500);
    expect(PLANS["modele-sur-mesure"].priceEur).toBe(5000);
  });

  it("calibre la périodicité : gratuit libre, mensuels 30 jours, sur-mesure sans expiration", () => {
    expect(PLANS.gratuit.cycle).toBe("gratuit");
    expect(PLANS.gratuit.accessDays).toBeNull();
    expect(PLANS.pro.cycle).toBe("mensuel");
    expect(PLANS.pro.accessDays).toBe(30);
    expect(PLANS.entreprise.cycle).toBe("mensuel");
    expect(PLANS.entreprise.accessDays).toBe(30);
    expect(PLANS["modele-sur-mesure"].cycle).toBe("unique");
    expect(PLANS["modele-sur-mesure"].accessDays).toBeNull();
  });

  it("aligne les prix XAF sur la parité fixe EUR→XAF (tolérance boutique ±1 %)", () => {
    for (const planId of PLAN_ORDER) {
      const plan = PLANS[planId];
      if (plan.priceEur === 0) continue;
      const ratio = plan.priceXaf / plan.priceEur;
      expect(ratio).toBeGreaterThan(EUR_XAF_RATE * 0.99);
      expect(ratio).toBeLessThan(EUR_XAF_RATE * 1.01);
    }
  });

  it("convertit un prix EUR en XAF arrondi à la dizaine", () => {
    expect(eurToXaf(15)).toBe(9840);
    expect(eurToXaf(500)).toBe(327980);
  });
});

describe("hiérarchie des fonctionnalités (entitlements)", () => {
  it("donne le plan gratuit aux micro-agents seulement", () => {
    expect(PLANS.gratuit.entitlements).toEqual(["micro_agents"]);
  });

  it("ouvre l'Agent Master, la priorité P2P, le RAG chiffré et les datasets au plan Pro", () => {
    for (const entitlement of ["agent_master", "p2p_priority", "rag_chiffre", "datasets_api"] as PlanEntitlement[]) {
      expect(PLANS.pro.entitlements).toContain(entitlement);
    }
  });

  it("réserve le mesh privé, le multi-postes et le support prioritaire au plan Entreprise", () => {
    for (const entitlement of ["private_mesh", "multi_postes", "support_prioritaire"] as PlanEntitlement[]) {
      expect(PLANS.entreprise.entitlements).toContain(entitlement);
      expect(PLANS.pro.entitlements).not.toContain(entitlement);
    }
  });

  it("réserve l'Arène d'Ondes et le paquet d'ondes au modèle sur-mesure", () => {
    for (const entitlement of ["arene_ondes", "paquet_ondes"] as PlanEntitlement[]) {
      expect(PLANS["modele-sur-mesure"].entitlements).toContain(entitlement);
      expect(PLANS.entreprise.entitlements).not.toContain(entitlement);
    }
  });

  it("emboîte chaque plan dans le suivant (aucun droit perdu en montant de gamme)", () => {
    for (let i = 1; i < PLAN_ORDER.length; i++) {
      const lower = PLANS[PLAN_ORDER[i - 1]].entitlements;
      const upper = PLANS[PLAN_ORDER[i]].entitlements;
      for (const entitlement of lower) {
        expect(upper).toContain(entitlement);
      }
    }
  });
});

describe("résolution des produits Chariow", () => {
  it("tombe sur le produit boutique déjà créé pour le plan Pro", () => {
    delete process.env.CHARIOW_PLAN_PRO_PRODUCT_ID;
    expect(resolvePlanProductId("pro")).toBe("prd_svqonju7");
  });

  it("laisse l'offre Entreprise non achetable tant que son produit n'est pas configuré", () => {
    delete process.env.CHARIOW_PLAN_ENTREPRISE_PRODUCT_ID;
    expect(resolvePlanProductId("entreprise")).toBeNull();
    expect(toPublicPlan("entreprise", null).purchasable).toBe(false);
  });

  it("privilégie la variable d'environnement sur le produit par défaut", () => {
    process.env.CHARIOW_PLAN_PRO_PRODUCT_ID = "prd_custom_pro";
    try {
      expect(resolvePlanProductId("pro")).toBe("prd_custom_pro");
    } finally {
      delete process.env.CHARIOW_PLAN_PRO_PRODUCT_ID;
    }
  });

  it("rejette un identifiant de plan inconnu", () => {
    expect(isKnownPlanId("pro")).toBe(true);
    expect(isKnownPlanId("gratuit")).toBe(true);
    expect(isKnownPlanId("diamond")).toBe(false);
    expect(isKnownPlanId(42)).toBe(false);
  });
});

describe("visites de paiement rattachées à la plateforme", () => {
  it("tague chaque checkout plan_subscription avec le plan et l'utilisateur", () => {
    const metadata = planCheckoutMetadata("pro", "user-123");
    expect(metadata.gen3ia_product).toBe("plan_subscription");
    expect(metadata.plan_id).toBe("pro");
    expect(metadata.user_id).toBe("user-123");
  });

  it("affiche le prix en FCFA avec l'équivalent EUR", () => {
    expect(formatPlanPrice("gratuit")).toBe("0 FCFA");
    expect(formatPlanPrice("pro")).toContain("9 750 FCFA");
    expect(formatPlanPrice("pro")).toContain("15 €");
    expect(formatPlanPrice("pro")).toContain("/ mois");
    expect(formatPlanPrice("modele-sur-mesure")).toContain("/ modèle");
  });

  it("marque l'offre courante sur la carte publique", () => {
    const card = toPublicPlan("pro", "pro");
    expect(card.current).toBe(true);
    const other = toPublicPlan("entreprise", "pro");
    expect(other.current).toBe(false);
    expect(other.purchasable).toBe(false);
  });
});
