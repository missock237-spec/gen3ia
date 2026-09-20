import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import {
  createChariowTopupCheckout,
  getChariowStoreUrl,
  getChariowTopupProductId,
} from "@/lib/billing/chariow";
import { WALLET_CURRENCY } from "@/lib/billing/wallet";
import { rateLimit } from "@/lib/security/rate-limit";
import { appendSecurityAuditEvent } from "@/lib/security/security-audit";
import { captureServerException } from "@/lib/observability/sentry";

function appOrigin(request: Request): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}

/**
 * POST /api/billing/topup
 *
 * Mode 1 (CHARIOW_TOPUP_PRODUCT_ID configured): creates a real Chariow
 * checkout session via the public API for the authenticated user. Chariow
 * requires first/last name and a phone number, so the first call without
 * details answers `requiresDetails: true` and the client resubmits with
 * `phone: { number, country_code }`.
 *
 * Mode 2 (fallback): redirects to the Chariow storefront configured in
 * CHARIOW_TOPUP_STORE_URL. Wallet credit then relies on the Pulse webhook.
 */
export async function POST(request: Request) {
  try {
    const token = await verifyFirebaseRequest(request);
    const topupLimit = rateLimit(`billing-topup:${token.uid}`, { limit: 10, windowMs: 10 * 60 * 1000 });
    if (!topupLimit.allowed) {
      return Response.json({ error: "Trop de tentatives de rechargement. Reessayez plus tard." }, { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(topupLimit.retryAfterMs / 1000))) } });
    }
    await appendSecurityAuditEvent({
      userId: token.uid,
      executionId: `topup_${Date.now()}`,
      toolName: "billing.topup",
      event: "started",
      input: { hasProductId: Boolean(getChariowTopupProductId()) },
    });
    const email = token.email?.trim().toLowerCase();
    if (!email) {
      throw new Error("Your Firebase account must have an email address for Chariow checkout.");
    }

    const body = await request.json().catch(() => ({}));
    const productId = getChariowTopupProductId();

    if (!productId) {
      const storeUrl = getChariowStoreUrl();
      if (!storeUrl) {
        throw new Error(
          "Le paiement Chariow n'est pas encore configuré (CHARIOW_TOPUP_PRODUCT_ID ou CHARIOW_TOPUP_STORE_URL requis).",
        );
      }
      return Response.json({ success: true, mode: "store", checkoutUrl: storeUrl });
    }

    const phoneNumber = String(body?.phone?.number ?? "").trim();
    const countryCode = String(body?.phone?.country_code ?? "").trim();
    if (!phoneNumber || !countryCode) {
      return Response.json({ success: true, mode: "checkout", requiresDetails: true });
    }

    const displayName = token.name?.trim() ?? "";
    const [firstName = "", ...restNames] = displayName.split(/\s+/).filter(Boolean);
    const fallbackName = email.split("@")[0]?.slice(0, 50) || "Gen3ia";

    const checkout = await createChariowTopupCheckout({
      productId,
      email,
      firstName: firstName || fallbackName,
      lastName: restNames.join(" ") || fallbackName,
      phoneNumber,
      countryCode,
      redirectUrl: `${appOrigin(request)}/billing?topup=success`,
      customerIp:
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
      paymentCurrency: WALLET_CURRENCY,
    });

    if (checkout.step === "already_purchased") {
      throw new Error(
        checkout.message ?? "Chariow indique que ce produit a déjà été acheté par ce compte.",
      );
    }
    if (checkout.step !== "payment" || !checkout.checkoutUrl) {
      throw new Error("Chariow n'a pas renvoyé d'URL de paiement pour cette recharge.");
    }

    return Response.json({
      success: true,
      mode: "checkout",
      checkoutUrl: checkout.checkoutUrl,
      saleId: checkout.saleId,
    });
  } catch (error) {
    captureServerException(error, { route: "billing.topup" });
    const message = error instanceof Error ? error.message : "Could not create top-up checkout";
    const status = message.includes("authorization") || message.includes("token") ? 401 : 400;
    return Response.json({ error: message }, { status });
  }
}
