import { FieldValue } from "@/lib/r2fs";
import { adminDb } from "@/lib/firebase/admin";

import { PLANS, isKnownPlanId, type PlanDefinition, type PlanEntitlement, type PlanId } from "./plans";

/**
 * Abonnements aux offres Gen3ia (grille tarifaire Chariow).
 *
 * Une vente Chariow (checkout plateforme ou licence activée) ouvre l'accès à
 * un plan. Deux barrières financières :
 *  - collection `planActivations` : journal idempotent par référence de vente
 *    (`plan_${saleId}` ou `licence_${licenseKey}`) — deux livraisons du même
 *    webhook ou un rachat ré-activé ne re-poussent jamais la fenêtre d'accès ;
 *  - document `userPlans/{userId}` : l'état d'accès CONSULTABLE (plan actif +
 *    expiration) utilisé par le gating des fonctionnalités.
 *
 * Les plans mensuels (pro, entreprise) expirent après `accessDays` jours —
 * l'utilisateur repasse alors implicitement au plan gratuit ou rachète une
 * licence. Le plan sur-mesure est un achat unitaire sans expiration.
 */

const PLANS_COLLECTION = "userPlans";
const ACTIVATIONS_COLLECTION = "planActivations";

/** Fenêtre de grâce post-expiration : les renouvellements décalés ne coupent pas l'accès sec. */
export const GRACE_PERIOD_DAYS = 3;

export interface PlanState {
  userId: string;
  planId: PlanId;
  /** false dès que la fenêtre d'accès est dépassée (repasse au plan gratuit). */
  active: boolean;
  source: "checkout" | "licence" | "gratuit";
  activatedAt: number;
  expiresAt: number | null;
  lastSaleId: string | null;
  lastLicenseKey: string | null;
}

function planDocRef(userId: string) {
  if (!userId?.trim()) throw new Error("Plan requires a userId.");
  return adminDb.collection(PLANS_COLLECTION).doc(userId);
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  return Date.now();
}

/** État d'accès courant d'un utilisateur (gratuit implicite sans document). */
export async function getPlanState(userId: string): Promise<PlanState> {
  const snap = await planDocRef(userId).get();
  if (!snap.exists) {
    return {
      userId,
      planId: "gratuit",
      active: true,
      source: "gratuit",
      activatedAt: Date.now(),
      expiresAt: null,
      lastSaleId: null,
      lastLicenseKey: null,
    };
  }
  const data = snap.data() ?? {};
  const planId = isKnownPlanId(data.planId) ? data.planId : "gratuit";
  const expiresAt = data.expiresAt != null ? toMillis(data.expiresAt) : null;
  const activatedAt = toMillis(data.activatedAt);
  const active = expiresAt == null ? true : expiresAt + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000 > Date.now();
  return {
    userId,
    planId: active ? planId : "gratuit",
    active,
    source: (data.source as PlanState["source"]) ?? "gratuit",
    activatedAt,
    expiresAt,
    lastSaleId: data.lastSaleId != null ? String(data.lastSaleId) : null,
    lastLicenseKey: data.lastLicenseKey != null ? String(data.lastLicenseKey) : null,
  };
}

/** Résultat discriminé d'une activation (utile pour le webhook et les tests). */
export type PlanActivationResult =
  | { kind: "activated"; state: PlanState }
  | { kind: "duplicate"; state: PlanState }
  | { kind: "ignored"; reason: "unknown_plan" };

/**
 * Active (ou étend) l'accès d'un utilisateur à un plan après paiement.
 * Idempotent par référence de vente : la même vente Chariow re-délivrée ne
 * repousse pas la fenêtre d'accès.
 */
export async function activatePlanFromSale(params: {
  userId: string;
  planId: string;
  saleId: string;
  source: PlanState["source"];
}): Promise<PlanActivationResult> {
  if (!isKnownPlanId(params.planId)) return { kind: "ignored", reason: "unknown_plan" };
  const definition = PLANS[params.planId as PlanId];
  const reference = `plan_${params.saleId.trim()}`;
  return activatePlan(params.userId, definition, reference, params.saleId.trim(), null, params.source);
}

/**
 * Active l'accès via une clé de licence Chariow déjà payée sur la boutique
 * (type de produit « license »). Référence d'idempotence dédiée aux licences.
 */
export async function activatePlanFromLicense(params: {
  userId: string;
  planId: string;
  licenseKey: string;
}): Promise<PlanActivationResult> {
  if (!isKnownPlanId(params.planId)) return { kind: "ignored", reason: "unknown_plan" };
  const definition = PLANS[params.planId as PlanId];
  const licenseKey = params.licenseKey.trim();
  return activatePlan(params.userId, definition, `licence_${licenseKey}`, null, licenseKey, "licence");
}

async function activatePlan(
  userId: string,
  definition: PlanDefinition,
  reference: string,
  saleId: string | null,
  licenseKey: string | null,
  source: PlanState["source"],
): Promise<PlanActivationResult> {
  const planRef = planDocRef(userId);
  const activationRef = adminDb.collection(ACTIVATIONS_COLLECTION).doc(reference);

  const outcome = await adminDb.runTransaction(async (tx): Promise<{ state: PlanState; created: boolean }> => {
    const [activationSnap, planSnap] = await Promise.all([tx.get(activationRef), tx.get(planRef)]);

    // Déjà activée : pas de prolongation (idempotence financière).
    if (activationSnap.exists) {
      const existing = planSnap.data() ?? {};
      const planId = isKnownPlanId(existing.planId) ? existing.planId : "gratuit";
      const expiresAt = existing.expiresAt != null ? toMillis(existing.expiresAt) : null;
      return {
        created: false,
        state: {
          userId,
          planId,
          active: expiresAt == null || expiresAt + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000 > Date.now(),
          source: (existing.source as PlanState["source"]) ?? source,
          activatedAt: toMillis(existing.activatedAt),
          expiresAt,
          lastSaleId: existing.lastSaleId != null ? String(existing.lastSaleId) : null,
          lastLicenseKey: existing.lastLicenseKey != null ? String(existing.lastLicenseKey) : null,
        },
      };
    }

    // L'accès s'empile à partir de la fin de la fenêtre actuelle (renouvellement
    // anticipé = pas de perte de temps restant) ; expiration passée → repart de maintenant.
    const previous = planSnap.data() ?? {};
    const previousExpires = previous.expiresAt != null ? toMillis(previous.expiresAt) : null;
    const base = definition.accessDays == null
      ? null
      : Math.max(Date.now(), previousExpires ?? 0) + definition.accessDays * 24 * 60 * 60 * 1000;
    const activatedAt = toMillis(previous.activatedAt) || Date.now();

    const next: PlanState = {
      userId,
      planId: definition.id,
      active: true,
      source,
      activatedAt,
      expiresAt: base,
      lastSaleId: saleId,
      lastLicenseKey: licenseKey,
    };

    tx.create(activationRef, {
      userId,
      planId: definition.id,
      reference,
      saleId,
      licenseKey,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(planRef, { ...next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { state: next, created: true };
  });

  return outcome.created ? { kind: "activated", state: outcome.state } : { kind: "duplicate", state: outcome.state };
}

/**
 * Gating fonctionnel : lève si l'utilisateur n'a pas l'entitlement (plan
 * gratuit implicite pour les fonctionnalités ouvertes). Consommé par les
 * routes API et les capacités des agents (essaim, arène, datasets).
 */
export async function requirePlanEntitlement(userId: string, entitlement: PlanEntitlement): Promise<PlanState> {
  const state = await getPlanState(userId);
  const definition = PLANS[state.planId];
  if (!definition.entitlements.includes(entitlement)) {
    throw new Error(
      `Cette fonctionnalité nécessite un abonnement supérieur (${entitlement}). Voir /billing pour les offres Gen3ia.`,
    );
  }
  return state;
}

/** Variante booléenne (UI, capacités affichées, essaim P2P). */
export async function hasPlanEntitlement(userId: string, entitlement: PlanEntitlement): Promise<boolean> {
  const state = await getPlanState(userId);
  return PLANS[state.planId].entitlements.includes(entitlement);
}
