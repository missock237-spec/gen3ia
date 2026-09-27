const CHARIOW_BASE_URL = (process.env.CHARIOW_API_BASE_URL ?? "https://api.chariow.com/v1").replace(/\/+$/, "");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export function getChariowTopupProductId(): string | null {
  return process.env.CHARIOW_TOPUP_PRODUCT_ID?.trim() || null;
}

export function getChariowStoreUrl(): string | null {
  return process.env.CHARIOW_TOPUP_STORE_URL?.trim() || null;
}

export interface ChariowCheckoutInput {
  productId: string;
  email: string;
  firstName: string;
  lastName: string;
  phoneNumber: string;
  countryCode: string;
  redirectUrl: string;
  customerIp?: string;
  paymentCurrency?: string;
}

export interface ChariowCheckoutResult {
  /** `payment` (redirect to checkoutUrl), `completed`, `already_purchased` */
  step: string;
  message: string | null;
  saleId: string | null;
  checkoutUrl: string | null;
}

interface ChariowApiEnvelope {
  message?: string;
  data?: unknown;
  errors?: unknown;
}

// Réponse JSON brute de l'API Chariow (structure non contractuelle, lue
// défensivement aux points d'usage : String(...), Number.isFinite, != null).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- frontière JSON externe unique et centralisée
type ChariowApiData = Record<string, any>;

async function chariowFetch(
  path: string,
  init?: { method?: string; body?: string },
):
  Promise<{ status: number; data: ChariowApiData }> {
  const apiKey = required("CHARIOW_API_KEY");
  const response = await fetch(`${CHARIOW_BASE_URL}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: init?.body,
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as ChariowApiEnvelope | null;
  if (!response.ok) {
    const detail =
      payload?.message ??
      (payload?.errors ? JSON.stringify(payload.errors) : `HTTP ${response.status}`);
    throw new Error(`Chariow API error (${response.status}): ${detail}`);
  }
  return { status: response.status, data: payload?.data ?? payload ?? {} };
}

/**
 * Creates a Chariow checkout session for a wallet top-up product.
 *
 * Requires a fixed-price product (Downloadable/License). Pay-what-you-want,
 * Service and Coaching products are rejected by the Chariow public API.
 * The sale is tagged with `custom_metadata.gen3ia_product = "wallet_topup"`
 * so the Pulse webhook can identify wallet credits even without a
 * configured CHARIOW_TOPUP_PRODUCT_ID.
 */
export async function createChariowTopupCheckout(
  input: ChariowCheckoutInput,
): Promise<ChariowCheckoutResult> {
  const body = {
    product_id: input.productId,
    email: input.email,
    first_name: input.firstName.slice(0, 50),
    last_name: input.lastName.slice(0, 50),
    phone: {
      number: input.phoneNumber.replace(/\D/g, ""),
      country_code: input.countryCode.toUpperCase().slice(0, 10),
    },
    ...(input.paymentCurrency ? { payment_currency: input.paymentCurrency.toUpperCase() } : {}),
    redirect_url: input.redirectUrl.slice(0, 2048),
    ...(input.customerIp ? { customer_ip: input.customerIp } : {}),
    custom_metadata: { gen3ia_product: "wallet_topup" },
  };

  const { data } = await chariowFetch("/checkout", {
    method: "POST",
    body: JSON.stringify(body),
  });

  return {
    step: String(data?.step ?? ""),
    message: data?.message != null ? String(data.message) : null,
    saleId: data?.purchase?.id != null ? String(data.purchase.id) : null,
    checkoutUrl: data?.payment?.checkout_url != null ? String(data.payment.checkout_url) : null,
  };
}

export interface ChariowSale {
  id: string;
  status: string;
  amountValue: number | null;
  currency: string;
  customerEmail: string;
  productId: string;
}

function normalizeEmail(value: unknown): string {
  return value ? String(value).trim().toLowerCase() : "";
}

/**
 * Fetches a sale from the Chariow API (`GET /v1/sales/{id}`).
 * Used as a post-payment safety net so wallet credits do not depend
 * solely on Pulse webhook delivery.
 */
export async function getChariowSale(saleId: string): Promise<ChariowSale> {
  const clean = saleId.trim();
  if (!/^sal_[A-Za-z0-9_-]+$/.test(clean)) {
    throw new Error("Identifiant de vente Chariow invalide.");
  }

  const { data } = await chariowFetch(`/sales/${encodeURIComponent(clean)}`);
  return {
    id: String(data?.id ?? clean),
    status: String(data?.status ?? "").toLowerCase(),
    amountValue: Number.isFinite(Number(data?.amount?.value)) ? Number(data?.amount?.value) : null,
    currency: String(data?.amount?.currency ?? "").toUpperCase(),
    customerEmail: normalizeEmail(data?.customer?.email),
    productId: data?.product?.id != null ? String(data.product.id) : "",
  };
}

export interface ChariowExtensionCheckoutInput {
  productId: string;
  email: string;
  firstName: string;
  lastName: string;
  phoneNumber: string;
  countryCode: string;
  redirectUrl: string;
  customerIp?: string;
  paymentCurrency?: string;
  metadata: Record<string, string>;
}

/**
 * Creates a Chariow checkout for an extension purchase. The sale is tagged
 * with `custom_metadata.gen3ia_product = "extension_purchase"` plus the
 * caller-provided metadata so the Pulse webhook can grant the entitlement.
 */
export async function createChariowExtensionCheckout(
  input: ChariowExtensionCheckoutInput,
): Promise<ChariowCheckoutResult> {
  const body = {
    product_id: input.productId,
    email: input.email,
    first_name: input.firstName.slice(0, 50),
    last_name: input.lastName.slice(0, 50),
    phone: {
      number: input.phoneNumber.replace(/\D/g, ""),
      country_code: input.countryCode.toUpperCase().slice(0, 10),
    },
    ...(input.paymentCurrency ? { payment_currency: input.paymentCurrency.toUpperCase() } : {}),
    redirect_url: input.redirectUrl.slice(0, 2048),
    ...(input.customerIp ? { customer_ip: input.customerIp } : {}),
    custom_metadata: { gen3ia_product: "extension_purchase", ...input.metadata },
  };

  const { data } = await chariowFetch("/checkout", {
    method: "POST",
    body: JSON.stringify(body),
  });

  return {
    step: String(data?.step ?? ""),
    message: data?.message != null ? String(data.message) : null,
    saleId: data?.purchase?.id != null ? String(data.purchase.id) : null,
    checkoutUrl: data?.payment?.checkout_url != null ? String(data.payment.checkout_url) : null,
  };
}
