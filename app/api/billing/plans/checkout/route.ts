import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import { createChariowPlanCheckout } from "@/lib/billing/chariow";
import { WALLET_CURRENCY } from "@/lib/billing/wallet";
import { isKnownPlanId, planCheckoutMetadata, resolvePlanProductId } from "@/lib/billing/plans";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { appendSecurityAuditEvent } from "@/lib/security/security-audit";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { captureServerException } from "@/lib/observability/sentry";

function appOrigin(request: Request): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}

/**
 * POST /api/billing/plans/checkout
 *
 * Ouvre une visite de paiement Chariow pour un abonnement à une offre Gen3ia
 * (grille tarifaire). La session est rattachée à la plateforme :
 *  - custom_metadata {gen3ia_product: plan_subscription, plan_id, user_id} —
 *    le webhook Pulse active l'accès au paiement ;
 *  - redirect_url → retour /billing?plan=success&planId=… ;
 *  - embed_origins → l'origine de la plateforme est déclarée à Chariow.
 *
 * Même contrat que /api/billing/topup : premier appel sans téléphone →
 * `requiresDetails: true`, le client renvoie phone:{number, country_code}.
 */
export async function POST(request: Request) {
  try {
    const token = await verifyFirebaseRequest(request);
    const planLimit = await enforceRateLimit(`billing-plan-checkout:${token.uid}`, { limit: 10, windowMs: 10 * 60 * 1000 });
    if (!planLimit.allowed) {
      return Response.json(
        { error: "Trop de tentatives d'abonnement. Reessayez plus tard." },
        { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(planLimit.retryAfterMs / 1000))) } },
      );
    }

    const body = await request.json().catch(() => ({}));
    const planId = String(body?.planId ?? "");
    if (!isKnownPlanId(planId) || planId === "gratuit") {
      return Response.json({ error: "Offre inconnue ou non payante." }, { status: 400 });
    }

    const productId = resolvePlanProductId(planId);
    if (!productId) {
      return Response.json(
        { error: "Cette offre n'est pas encore ouverte au paiement. Réessayez bientôt." },
        { status: 409 },
      );
    }

    await appendSecurityAuditEvent({
      userId: token.uid,
      executionId: `plan_checkout_${Date.now()}`,
      toolName: "billing.plan.checkout",
      event: "started",
      input: { planId },
    });

    const email = token.email?.trim().toLowerCase();
    if (!email) {
      throw new Error("Your Gen3ia account must have an email address for Chariow checkout.");
    }

    const phoneNumber = String(body?.phone?.number ?? "").trim();
    const countryCode = String(body?.phone?.country_code ?? "").trim();
    if (!phoneNumber || !countryCode) {
      return Response.json({ success: true, mode: "checkout", requiresDetails: true });
    }

    const displayName = token.name?.trim() ?? "";
    const [firstName = "", ...restNames] = displayName.split(/\s+/).filter(Boolean);
    const fallbackName = email.split("@")[0]?.slice(0, 50) || "Gen3ia";

    const checkout = await createChariowPlanCheckout({
      productId,
      email,
      firstName: firstName || fallbackName,
      lastName: restNames.join(" ") || fallbackName,
      phoneNumber,
      countryCode,
      redirectUrl: `${appOrigin(request)}/billing?plan=success&planId=${encodeURIComponent(planId)}`,
      customerIp: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
      paymentCurrency: WALLET_CURRENCY,
      metadata: planCheckoutMetadata(planId, token.uid),
    });

    if (checkout.step === "already_purchased") {
      throw new Error(
        checkout.message ?? "Chariow indique que ce produit a déjà été acheté par ce compte.",
      );
    }
    if (checkout.step !== "payment" || !checkout.checkoutUrl) {
      throw new Error("Chariow n'a pas renvoyé d'URL de paiement pour cette offre.");
    }

    await appendSecurityAuditEvent({
      userId: token.uid,
      executionId: `plan_checkout_${Date.now()}`,
      toolName: "billing.plan.checkout",
      event: "completed",
      input: { planId, saleId: checkout.saleId },
    });

    return Response.json({
      success: true,
      mode: "checkout",
      checkoutUrl: checkout.checkoutUrl,
      saleId: checkout.saleId,
    });
  } catch (error) {
    captureServerException(error, { route: "billing.plans.checkout" });
    return Response.json(errorBody(error, "Could not create plan checkout"), { status: errorStatus(error, 400) });
  }
}
