import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import { getChariowSale, getChariowTopupProductId } from "@/lib/billing/chariow";
import { applyTopup, getWallet, WALLET_CURRENCY } from "@/lib/billing/wallet";

const CREDITABLE_STATUSES = new Set(["completed", "settled"]);

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
    if (sale.customerEmail && sale.customerEmail !== email) {
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
    const message = error instanceof Error ? error.message : "Could not verify top-up";
    const status = message.includes("authorization") || message.includes("token") ? 401 : 400;
    return Response.json({ error: message }, { status });
  }
}
