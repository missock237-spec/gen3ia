import crypto from "node:crypto";
import { getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { adminDb } from "@/lib/firebase/admin";
import { applyTopup, WALLET_CURRENCY } from "@/lib/billing/wallet";
import { settleChariowExtensionPurchase } from "@/lib/extensions/entitlements";

const CREDITABLE_STATUSES = new Set(["completed", "settled"]);

function verifySignature(raw: string, received: string | null): boolean {
  const secret = process.env.CHARIOW_PULSE_SECRET?.trim();
  if (!secret || !received?.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Charge utile du webhook Chariow (successful.sale) — lue défensivement
// (String(...), Number.isFinite, != null) aux points d'usage.
type ChariowWebhookPayload = {
  event?: string | null;
  customer?: { email?: unknown } | null;
  product?: { id?: unknown } | null;
  sale?: {
    id?: unknown;
    status?: unknown;
    amount?: { value?: unknown; currency?: unknown } | null;
    custom_metadata?: Record<string, unknown> | null;
  } | null;
};

function isTopupSale(payload: ChariowWebhookPayload): boolean {
  const configuredProductId = process.env.CHARIOW_TOPUP_PRODUCT_ID?.trim();
  if (configuredProductId && String(payload?.product?.id ?? "") === configuredProductId) return true;
  return String(payload?.sale?.custom_metadata?.gen3ia_product ?? "") === "wallet_topup";
}

function extensionSaleMetadata(payload: ChariowWebhookPayload) {
  const metadata: Record<string, unknown> = payload?.sale?.custom_metadata ?? {};
  return {
    product: String(metadata.gen3ia_product ?? ""),
    purchaseId: String(metadata.purchaseId ?? ""),
    userId: String(metadata.userId ?? ""),
    extensionId: String(metadata.extensionId ?? ""),
  };
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get("x-chariow-signature"))) {
    return new Response("Invalid signature", { status: 401 });
  }

  const deliveryId = request.headers.get("x-pulse-delivery-id");
  const event = request.headers.get("x-pulse-event");
  if (!deliveryId) return new Response("Missing delivery id", { status: 400 });

  let payload: ChariowWebhookPayload;
  try {
    payload = JSON.parse(raw) as ChariowWebhookPayload;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (event && event !== "successful.sale" && payload.event !== "successful.sale") {
    return Response.json({ received: true, ignored: true });
  }

  const deliveryRef = adminDb.collection("chariowPulseDeliveries").doc(deliveryId);
  const claimed = await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(deliveryRef);
    if (snap.exists) return false;
    tx.create(deliveryRef, {
      deliveryId,
      event: payload.event ?? event ?? null,
      receivedAt: new Date(),
      status: "processing",
    });
    return true;
  });
  if (!claimed) return Response.json({ received: true, duplicate: true });

  try {
    const meta = extensionSaleMetadata(payload);
    if (meta.product === "extension_purchase") {
      const saleId = String(payload?.sale?.id ?? "");
      const saleStatus = String(payload?.sale?.status ?? "completed").toLowerCase();
      const amountValue = Number(payload?.sale?.amount?.value);
      const currency = String(payload?.sale?.amount?.currency ?? "").toUpperCase();
      const productId = String(payload?.product?.id ?? "");

      if (!meta.purchaseId || !meta.userId || !meta.extensionId || !saleId) {
        throw new Error("Extension purchase payload is missing purchase, user, extension, or sale reference.");
      }
      if (!CREDITABLE_STATUSES.has(saleStatus)) {
        throw new Error(`Sale status ${saleStatus} is not creditable.`);
      }
      if (!Number.isFinite(amountValue) || amountValue <= 0) {
        throw new Error("Extension sale amount is invalid.");
      }
      if (!currency) throw new Error("Extension sale currency is missing.");
      if (!productId) throw new Error("Extension sale product id is missing.");

      const result = await settleChariowExtensionPurchase({
        purchaseId: meta.purchaseId,
        providerRef: `chariow:${saleId}`,
        saleId,
        productId,
        userId: meta.userId,
        extensionId: meta.extensionId,
        amountMinor: Math.round(amountValue * 100),
        currency,
        status: saleStatus,
      });

      await deliveryRef.update({
        status: "processed",
        kind: "extension_purchase",
        purchaseId: meta.purchaseId,
        userId: meta.userId,
        extensionId: meta.extensionId,
        saleId,
        productId,
        granted: result.granted,
        processedAt: new Date(),
      });
      return Response.json({ received: true, kind: "extension_purchase", granted: result.granted });
    }

    if (!isTopupSale(payload)) {
      await deliveryRef.update({ status: "ignored", reason: "not_a_wallet_topup_sale", processedAt: new Date() });
      return Response.json({ received: true, ignored: true });
    }

    const customerEmail = String(payload.customer?.email ?? "").trim().toLowerCase();
    const amount = Number(payload.sale?.amount?.value);
    const currency = String(payload.sale?.amount?.currency ?? "").toUpperCase();
    const saleId = String(payload.sale?.id ?? "");
    const saleStatus = String(payload.sale?.status ?? "completed").toLowerCase();
    if (!customerEmail || !saleId || !Number.isFinite(amount) || amount <= 0) {
      throw new Error("Chariow successful sale payload is missing required wallet fields.");
    }
    if (!CREDITABLE_STATUSES.has(saleStatus)) {
      throw new Error(`Sale status ${saleStatus} is not creditable.`);
    }
    if (currency !== WALLET_CURRENCY) {
      throw new Error(`Top-up currency ${currency} does not match wallet currency ${WALLET_CURRENCY}.`);
    }

    let user;
    try {
      user = await getAuth(getApps()[0]!).getUserByEmail(customerEmail);
    } catch {
      await deliveryRef.update({
        status: "failed",
        reason: "firebase_user_not_found",
        customerEmail,
        saleId,
        failedAt: new Date(),
      });
      return Response.json({ received: true, credited: false, reason: "user_not_found" });
    }

    const amountMinor = Math.round(amount * 100);
    const wallet = await applyTopup({
      userId: user.uid,
      amountMinor,
      currency,
      providerReference: saleId,
      metadata: {
        customerEmail,
        productId: String(payload.product?.id ?? ""),
        source: "pulse_webhook",
      },
    });
    await deliveryRef.update({ status: "processed", userId: user.uid, saleId, amountMinor, processedAt: new Date() });
    return Response.json({ received: true, credited: true, wallet });
  } catch (error) {
    await deliveryRef.update({
      status: "failed",
      error: error instanceof Error ? error.message.slice(0, 1000) : "Wallet credit failed",
      failedAt: new Date(),
    });
    return new Response("Webhook processing failed", { status: 500 });
  }
}
