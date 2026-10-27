import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import { getChariowSale, getChariowTopupProductId } from "@/lib/billing/chariow";
import { applyTopup, getWallet, WALLET_CURRENCY } from "@/lib/billing/wallet";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { clientIp, rateLimit } from "@/lib/security/rate-limit";

const CREDITABLE_STATUSES = new Set(["completed", "settled"]);

/** Anti-énumération de saleId : 20 vérifications / utilisateur / 10 min. */
const LIMITE_VERIFY = { limit: 20, windowMs: 10 * 60 * 1000 } as const;

/**
 * POST /api/billing/topup/verify  { saleId: "sal_..." }
 *
 * Post-payment safety net: the billing page calls this endpoint when the
 * customer returns from the Chariow checkout. It queries the sale from the
 * Chariow API and credits the wallet idempotently (the ledger entry
 * `chariow_<saleId>` is shared with the Pulse webhook, so a sale can never
 * be credited twice, whichever path lands first).
 */
export async function POST(request: Request) {
  try {
    const token = await verifyFirebaseRequest(request);

    // Rate limit (audit 2026-10-28) : l'endpoint interroge l'API Chariow à
    // partir d'un saleId fourni par le client — borné par utilisateur ET
    // par IP (anti-énumération de vente, anti-abus du quota Chariow).
    if (!rateLimit(`topup-verify:${token.uid}`, LIMITE_VERIFY).allowed) {
      return Response.json(
        { success: false, error: "Trop de vérifications — réessayez dans quelques minutes." },
        { status: 429, headers: { "retry-after": "60" } },
      );
    }
    if (!rateLimit(`topup-verify-ip:${clientIp(request)}`, LIMITE_VERIFY).allowed) {
      return Response.json(
        { success: false, error: "Trop de vérifications depuis cette adresse — réessayez dans quelques minutes." },
        { status: 429, headers: { "retry-after": "60" } },
      );
    }

    const email = token.email?.trim().toLowerCase();
    if (!email) throw new Error("Your Firebase account must have an email address.");

    const body = await request.json().catch(() => ({}));
    const saleId = String(body?.saleId ?? "").trim();
    if (!saleId) throw new Error("Identifiant de vente Chariow manquant.");

    const configuredProductId = getChariowTopupProductId();
    if (!configuredProductId) {
      throw new Error(
        "La vérification des recharges nécessite le produit Chariow configuré (CHARIOW_TOPUP_PRODUCT_ID).",
      );
    }

    const sale = await getChariowSale(saleId);

    if (!CREDITABLE_STATUSES.has(sale.status)) {
      const wallet = await getWallet(token.uid);
      return Response.json({
        success: true,
        credited: false,
        reason: `Paiement non encore confirmé (statut : ${sale.status || "inconnu"}). Le solde sera crédité dès la confirmation Chariow.`,
        wallet,
      });
    }
    // PROPRIÉTÉ DE LA VENTE (fail-closed, audit 2026-10-28) : l'e-mail
    // client Chariow est la SEULE preuve de propriété disponible ici —
    // une vente sans e-mail n'est PAS créditable par ce chemin (le webhook
    // signé Chariow reste la voie de crédit autorisée : il résout le
    // compte via les métadonnées du checkout ou l'e-mail client).
    const emailVente = sale.customerEmail?.trim().toLowerCase();
    if (!emailVente) {
      throw new Error(
        "Vente Chariow sans e-mail client — impossible de prouver la propriété ici. " +
          "Le crédit sera appliqué automatiquement par le webhook signé Chariow.",
      );
    }
    if (emailVente !== email) {
      throw new Error("Cette vente Chariow appartient à un autre compte.");
    }
    if (sale.productId !== configuredProductId) {
      throw new Error("Cette vente ne correspond pas au produit de recharge Gen3ia.");
    }
    if (sale.currency && sale.currency !== WALLET_CURRENCY) {
      throw new Error(`Devise de paiement ${sale.currency} incompatible avec le wallet ${WALLET_CURRENCY}.`);
    }
    if (!sale.amountValue || sale.amountValue <= 0) {
      throw new Error("Le montant de la vente Chariow est introuvable ou nul.");
    }

    const wallet = await applyTopup({
      userId: token.uid,
      amountMinor: Math.round(sale.amountValue * 100),
      currency: sale.currency || WALLET_CURRENCY,
      providerReference: sale.id,
      metadata: {
        customerEmail: sale.customerEmail || email,
        productId: sale.productId,
        source: "checkout_verify",
      },
    });

    return Response.json({ success: true, credited: true, wallet });
  } catch (error) {
    return Response.json(errorBody(error, "Could not verify top-up"), { status: errorStatus(error, 400) });
  }
}
