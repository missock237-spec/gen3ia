import { randomBytes } from "node:crypto";

import { adminDb } from "@/lib/firebase/admin";
import {
  reserveFunds,
  settleReservation,
  WALLET_CURRENCY,
  getWallet,
} from "@/lib/billing/wallet";
import { createChariowExtensionCheckout, getChariowStoreUrl } from "@/lib/billing/chariow";
import type { ExtensionDoc, PurchaseDoc } from "./repository";
import {
  createExtensionPurchase,
  createLicense,
  getEntitlement,
  getExtension,
  getExtensionPurchase,
  markPurchasePaid,
  upsertEntitlement,
} from "./repository";
import { canUseExtension, subscriptionExpiry, type PricingInfo } from "./pricing";
import { addDeveloperRevenue } from "./repository";

/**
 * Part développeur (80/20) enregistrée après un paiement RÉEL. Best-effort
 * journalisé : l'acheteur ne doit pas perdre son installation si l'écriture
 * de revenu échoue — l'achat reste rejouable depuis extensionPurchases.
 */
async function recordDeveloperRevenueSafe(params: {
  extension: ExtensionDoc;
  purchaseId: string;
  amountMinor: number;
  currency: string;
}): Promise<void> {
  try {
    await addDeveloperRevenue({
      developerId: params.extension.developerId,
      extensionId: params.extension.id,
      purchaseId: params.purchaseId,
      grossAmountMinor: params.amountMinor,
      currency: params.currency,
    });
  } catch (error) {
    console.error("[extensions] revenu développeur non enregistré (achat conservé):", error instanceof Error ? error.message : error);
  }
}

export interface PurchaseStartResult {
  mode: "wallet" | "chariow";
  purchaseId: string;
  checkoutUrl?: string;
  message?: string;
}

export async function assertExtensionUsable(userId: string, extension: ExtensionDoc): Promise<void> {
  const pricing: PricingInfo = extension.pricing as PricingInfo;
  const entitlement = await getEntitlement(extension.id, userId);
  const decision = canUseExtension(pricing, entitlement);
  if (!decision.allowed) throw new Error(decision.reason ?? "This extension is not usable.");
}

/** Grants or renews an extension entitlement. */
export async function grantEntitlement(params: {
  userId: string;
  extension: ExtensionDoc;
  source: "free" | "purchase" | "subscription" | "grant";
  purchaseId?: string | null;
}): Promise<number | null> {
  const pricing = params.extension.pricing as PricingInfo;
  let expiresAt: number | null = null;

  if (pricing.model === "subscription" && pricing.interval) {
    const existing = await getEntitlement(params.extension.id, params.userId);
    const existingExpiry = typeof existing?.expiresAt === "number" ? existing.expiresAt : Date.now();
    expiresAt = subscriptionExpiry(pricing.interval, Math.max(Date.now(), existingExpiry));
  }

  await upsertEntitlement({
    extensionId: params.extension.id,
    userId: params.userId,
    source: params.source,
    purchaseId: params.purchaseId ?? null,
    expiresAt,
    // Un NOUVEL achat réactive le renouvellement auto (intention fraîche) ;
    // les renouvellements internes passent par extendEntitlementAfterCharge
    // qui préserve le choix de l'utilisateur.
    autoRenew: pricing.model === "subscription" ? true : undefined,
  });
  return expiresAt;
}

function licenseKey(): string {
  return `g3lic_${randomBytes(24).toString("base64url")}`;
}

export async function purchaseWithWallet(params: {
  userId: string;
  extension: ExtensionDoc;
  reference: string;
}): Promise<PurchaseStartResult> {
  const pricing = params.extension.pricing as PricingInfo;
  if (pricing.model === "free") throw new Error("This extension is free — install it directly.");
  if (pricing.model !== "one_time" && pricing.model !== "subscription") {
    throw new Error("Usage-based extensions are charged per execution, not purchased upfront.");
  }
  const amountMinor = pricing.amountMinor ?? 0;
  if (amountMinor <= 0) throw new Error("Invalid extension price.");

  await getWallet(params.userId);
  const purchase = await createExtensionPurchase({
    userId: params.userId,
    extensionId: params.extension.id,
    provider: "wallet",
    amountMinor,
    currency: pricing.currency ?? WALLET_CURRENCY,
    kind: pricing.model === "subscription" ? "subscription" : "one_time",
  });

  try {
    await reserveFunds({
      userId: params.userId,
      amountMinor,
      reference: params.reference,
      metadata: { kind: "extension_purchase", extensionId: params.extension.id, purchaseId: purchase.id },
    });
    await settleReservation({
      userId: params.userId,
      reference: params.reference,
      reservedMinor: amountMinor,
      actualChargeMinor: amountMinor,
      metadata: { kind: "extension_purchase", extensionId: params.extension.id, purchaseId: purchase.id },
    });
  } catch (error) {
    await adminUpdatePurchaseFailed(purchase.id, error instanceof Error ? error.message : "wallet_error");
    throw error;
  }

  await markPurchasePaid(purchase.id, `wallet:${params.reference}`);
  await recordDeveloperRevenueSafe({
    extension: params.extension,
    purchaseId: purchase.id,
    amountMinor,
    currency: pricing.currency ?? WALLET_CURRENCY,
  });
  const expiresAt = await grantEntitlement({
    userId: params.userId,
    extension: params.extension,
    source: pricing.model === "subscription" ? "subscription" : "purchase",
    purchaseId: purchase.id,
  });
  await createLicense({
    purchaseId: purchase.id,
    userId: params.userId,
    extensionId: params.extension.id,
    licenseKey: licenseKey(),
    expiresAt,
  });
  return { mode: "wallet", purchaseId: purchase.id, message: "Paiement effectué via le wallet Gen3ia." };
}

async function adminUpdatePurchaseFailed(purchaseId: string, reason: string): Promise<void> {
  await adminDb.collection("extensionPurchases").doc(purchaseId).update({
    status: "failed",
    providerRef: `failed:${reason.slice(0, 200)}`,
    paidAt: null,
  }).catch(() => undefined);
}

export async function startChariowPurchase(params: {
  userId: string;
  extension: ExtensionDoc;
  email: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  countryCode?: string;
  redirectUrl: string;
  customerIp?: string;
}): Promise<PurchaseStartResult> {
  const productId = process.env.CHARIOW_EXT_PRODUCT_ID?.trim();
  if (!productId) throw new Error("Achat Chariow des extensions non configuré.");

  const pricing = params.extension.pricing as PricingInfo;
  if (pricing.model !== "one_time" && pricing.model !== "subscription") {
    throw new Error("Ce modèle de tarification n'est pas achetable à l'unité.");
  }
  const amountMinor = pricing.amountMinor ?? 0;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error("Invalid extension price.");

  const purchase = await createExtensionPurchase({
    userId: params.userId,
    extensionId: params.extension.id,
    provider: "chariow",
    amountMinor,
    currency: pricing.currency ?? WALLET_CURRENCY,
    kind: pricing.model === "subscription" ? "subscription" : "one_time",
  });
  const storeUrl = getChariowStoreUrl();
  const redirectUrl = params.redirectUrl || storeUrl || "https://gen3ia.online/marketplace";
  const checkout = await createChariowExtensionCheckout({
    productId,
    email: params.email,
    firstName: params.firstName ?? "Gen3ia",
    lastName: params.lastName ?? "User",
    phoneNumber: params.phoneNumber ?? "00000000",
    countryCode: params.countryCode ?? "CM",
    redirectUrl,
    customerIp: params.customerIp,
    metadata: { purchaseId: purchase.id, userId: params.userId, extensionId: params.extension.id },
  });
  if (!checkout.checkoutUrl) throw new Error(checkout.message ?? "Chariow n'a pas retourné d'URL de paiement.");
  return { mode: "chariow", purchaseId: purchase.id, checkoutUrl: checkout.checkoutUrl };
}

/**
 * Atomically settles a verified Chariow sale.
 * Purchase, entitlement and license are committed in one Firestore transaction.
 */
export async function settleChariowExtensionPurchase(params: {
  purchaseId: string;
  providerRef: string;
  saleId?: string;
  productId?: string;
  userId?: string;
  extensionId?: string;
  amountMinor?: number;
  currency?: string;
  status?: string;
}): Promise<{ granted: boolean }> {
  const purchase = await getExtensionPurchase(params.purchaseId);
  if (!purchase) throw new Error("Unknown extension purchase reference.");
  if (purchase.provider !== "chariow") throw new Error("Purchase provider mismatch.");

  if (purchase.status === "paid") {
    if (params.providerRef && purchase.providerRef && purchase.providerRef !== params.providerRef) {
      throw new Error("Provider reference does not match the settled purchase.");
    }
    return { granted: false };
  }
  if (purchase.status !== "pending") throw new Error(`Purchase is not payable: ${purchase.status}.`);
  if (params.saleId && params.providerRef !== `chariow:${params.saleId}`) throw new Error("Invalid Chariow provider reference.");
  if (params.userId && params.userId !== purchase.userId) throw new Error("Webhook user mismatch.");
  if (params.extensionId && params.extensionId !== purchase.extensionId) throw new Error("Webhook extension mismatch.");

  if (params.productId) {
    const configuredProductId = process.env.CHARIOW_EXT_PRODUCT_ID?.trim();
    if (!configuredProductId || params.productId !== configuredProductId) throw new Error("Chariow extension product mismatch.");
  }
  if (params.amountMinor !== undefined && params.amountMinor !== purchase.amountMinor) {
    throw new Error("Chariow amount does not match the pending purchase.");
  }
  if (params.currency && params.currency.toUpperCase() !== purchase.currency.toUpperCase()) {
    throw new Error("Chariow currency does not match the pending purchase.");
  }
  if (params.status && !["completed", "settled"].includes(params.status.toLowerCase())) {
    throw new Error(`Sale status ${params.status} is not creditable.`);
  }

  const extension = await getExtension(purchase.extensionId);
  if (!extension) throw new Error("Extension no longer exists.");
  if (extension.status !== "approved" || extension.deletedAt) throw new Error("Extension is not currently approved.");

  const pricing = extension.pricing as PricingInfo;
  if (pricing.model !== purchase.kind) throw new Error("Purchase pricing model no longer matches the extension.");
  const expectedAmount = pricing.amountMinor ?? 0;
  const expectedCurrency = (pricing.currency ?? WALLET_CURRENCY).toUpperCase();
  if (expectedAmount !== purchase.amountMinor) throw new Error("Extension price changed after checkout.");
  if (expectedCurrency !== purchase.currency.toUpperCase()) throw new Error("Extension currency changed after checkout.");

  const purchaseRef = adminDb.collection("extensionPurchases").doc(purchase.id);
  const entitlementRef = adminDb.collection("extensionEntitlements").doc(`${purchase.extensionId}__${purchase.userId}`);
  const licenseRef = adminDb.collection("extensionLicenses").doc(licenseKey());
  const extensionRef = adminDb.collection("extensions").doc(purchase.extensionId);
  const settlementNow = Date.now();
  let granted = false;

  await adminDb.runTransaction(async (tx) => {
    const purchaseSnap = await tx.get(purchaseRef);
    const extensionSnap = await tx.get(extensionRef);
    const entitlementSnap = await tx.get(entitlementRef);

    if (!purchaseSnap.exists) throw new Error("Purchase disappeared during settlement.");
    const currentPurchase = purchaseSnap.data() as PurchaseDoc;
    if (currentPurchase.status === "paid") {
      if (currentPurchase.providerRef && currentPurchase.providerRef !== params.providerRef) {
        throw new Error("Provider reference does not match the settled purchase.");
      }
      return;
    }
    if (currentPurchase.status !== "pending") throw new Error(`Purchase is not payable: ${currentPurchase.status}.`);
    if (!extensionSnap.exists) throw new Error("Extension disappeared during settlement.");

    const currentExtension = extensionSnap.data() as ExtensionDoc;
    if (currentExtension.status !== "approved" || currentExtension.deletedAt) {
      throw new Error("Extension is not currently approved.");
    }

    const currentEntitlement = entitlementSnap.exists
      ? entitlementSnap.data() as { createdAt?: number; expiresAt?: number | null; autoRenew?: boolean }
      : null;

    let expiresAt: number | null = null;
    if (currentPurchase.kind === "subscription" && pricing.interval) {
      const existingExpiry = typeof currentEntitlement?.expiresAt === "number" ? currentEntitlement.expiresAt : settlementNow;
      expiresAt = subscriptionExpiry(pricing.interval, Math.max(settlementNow, existingExpiry));
    }

    tx.update(purchaseRef, { status: "paid", providerRef: params.providerRef, paidAt: settlementNow });
    tx.set(entitlementRef, {
      id: `${purchase.extensionId}__${purchase.userId}`,
      extensionId: purchase.extensionId,
      userId: purchase.userId,
      status: "active",
      source: currentPurchase.kind === "subscription" ? "subscription" : "purchase",
      purchaseId: purchase.id,
      expiresAt,
      // Nouvel achat Chariow = intention fraîche : autoRenew activé.
      autoRenew: currentPurchase.kind === "subscription" ? true : (currentEntitlement?.autoRenew ?? false),
      createdAt: typeof currentEntitlement?.createdAt === "number" ? currentEntitlement.createdAt : settlementNow,
      updatedAt: settlementNow,
    });
    tx.create(licenseRef, {
      licenseKey: licenseRef.id,
      purchaseId: purchase.id,
      userId: purchase.userId,
      extensionId: purchase.extensionId,
      status: "active",
      expiresAt,
      createdAt: settlementNow,
    });
    granted = true;
  });

  if (granted) {
    await recordDeveloperRevenueSafe({
      extension,
      purchaseId: purchase.id,
      amountMinor: purchase.amountMinor,
      currency: purchase.currency,
    });
  }

  return { granted };
}
