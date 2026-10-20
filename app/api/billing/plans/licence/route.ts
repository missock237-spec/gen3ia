import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import {
  activateChariowLicense,
  getChariowLicense,
} from "@/lib/billing/chariow";
import { activatePlanFromLicense } from "@/lib/billing/abonnements";
import { PLANS, PLAN_ORDER, type PlanId } from "@/lib/billing/plans";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { appendSecurityAuditEvent } from "@/lib/security/security-audit";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { captureServerException } from "@/lib/observability/sentry";

/**
 * Mappe un identifiant produit Chariow vers le plan Gen3ia correspondant
 * (les produits de la grille tarifaire sont déclarés par variables d'env
 * et par le produit boutique déjà créé pour l'offre Pro).
 */
function planForProductId(productId: string): PlanId | null {
  if (!productId) return null;
  for (const planId of PLAN_ORDER) {
    if (PLANS[planId].priceXaf === 0) continue;
    const resolved = process.env[PLANS[planId].productIdEnv]?.trim() || PLANS[planId].defaultProductId;
    if (resolved && resolved === productId) return planId;
  }
  return null;
}

/**
 * POST /api/billing/plans/licence
 *
 * Active une offre Gen3ia à partir d'une clé de licence Chariow achetée sur
 * la boutique (type de produit « license » — l'offre Pro existante). Vérifie
 * la clé auprès de Chariow (GET /licenses/{key}), l'attache au compte
 * (POST /licenses/{key}/activate) puis ouvre l'accès au plan correspondant.
 */
export async function POST(request: Request) {
  try {
    const token = await verifyFirebaseRequest(request);
    const licenceLimit = await enforceRateLimit(`billing-plan-licence:${token.uid}`, { limit: 8, windowMs: 10 * 60 * 1000 });
    if (!licenceLimit.allowed) {
      return Response.json(
        { error: "Trop de tentatives d'activation. Reessayez plus tard." },
        { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(licenceLimit.retryAfterMs / 1000))) } },
      );
    }

    const body = await request.json().catch(() => ({}));
    const licenseKey = String(body?.licenseKey ?? "").trim();
    if (!licenseKey) {
      return Response.json({ error: "Clé de licence requise." }, { status: 400 });
    }

    const license = await getChariowLicense(licenseKey);
    if (["revoked", "expired", "disabled"].includes(license.status)) {
      return Response.json(
        { error: `Cette licence est ${license.status === "revoked" ? "révoquée" : license.status === "expired" ? "expirée" : "désactivée"}.` },
        { status: 409 },
      );
    }

    const planId = planForProductId(license.productId);
    if (!planId) {
      return Response.json(
        { error: "Cette clé de licence ne correspond à aucune offre Gen3ia." },
        { status: 422 },
      );
    }

    await activateChariowLicense(license.licenseKey, `gen3ia:${token.uid}`);

    const result = await activatePlanFromLicense({ userId: token.uid, planId, licenseKey: license.licenseKey });
    if (result.kind === "ignored") {
      return Response.json({ error: "Offre inconnue." }, { status: 422 });
    }

    await appendSecurityAuditEvent({
      userId: token.uid,
      executionId: `plan_licence_${Date.now()}`,
      toolName: "billing.plan.licence",
      event: "completed",
      input: { planId, licenseKey: license.licenseKey, duplicate: result.kind === "duplicate" },
    });

    return Response.json({
      success: true,
      planId,
      alreadyActivated: result.kind === "duplicate",
      plan: toPublicState(result.state),
    });
  } catch (error) {
    captureServerException(error, { route: "billing.plans.licence" });
    return Response.json(errorBody(error, "Could not activate license"), { status: errorStatus(error, 400) });
  }
}

function toPublicState(state: { planId: PlanId; expiresAt: number | null }) {
  return { planId: state.planId, expiresAt: state.expiresAt };
}
