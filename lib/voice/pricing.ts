/**
 * Tarification des numéros virtuels Gen3ia — marge fournisseur.
 *
 * Principe commercial (exigence produit) : Gen3ia achète un numéro chez le
 * fournisseur (Twilio) au prix mensuel réel, et le revend à l'utilisateur
 * avec une MARGE DE 20 % — ex. fournisseur 5 €/mois ⇒ vendu 6 €/mois.
 *
 * Sources :
 *  - Prix fournisseur réel : API Pricing Twilio (par pays, type Local),
 *    mise en cache Redis 24 h (le prix mensuel change rarement).
 *  - Repli : GEN3IA_PHONE_PROVIDER_USD_MINOR (centièmes de dollar, défaut
 *    500 = 5,00 USD/mois) pour continuer à servir l'UI si l'API Pricing
 *    est indisponible.
 *  - Marge : GEN3IA_NUMBER_MARKUP_BPS (points de base, défaut 2000 = 20 %),
 *    arrondie au cent supérieur.
 *  - Facturation wallet (XAF par défaut) : conversion via
 *    GEN3IA_USD_TO_XAF (défaut 600) — le prix vendu affiché reste en USD,
 *    le débit wallet est converti explicitement et journalisé.
 */

import { cacheGet, cacheSet } from "@/lib/cache/redis";
import { getTwilioConfig } from "@/lib/integrations/twilio/voice";

export const DEFAULT_MARKUP_BPS = 2_000;
export const FALLBACK_PROVIDER_USD_MINOR = 500;
export const DEFAULT_USD_TO_XAF = 600;

export interface NumberPricing {
  /** Prix mensuel fournisseur, en centièmes d'USD (500 = 5,00 USD). */
  providerPriceUsdMinor: number;

  /** Prix mensuel vendu à l'utilisateur, en centièmes d'USD (marge incluse). */
  sellPriceUsdMinor: number;

  /** Marge appliquée en points de base (2000 = 20 %). */
  markupBps: number;

  currency: "USD";

  /** Source du prix fournisseur (transparence totale côté UI). */
  source: "twilio-pricing-api" | "fallback-configuration";
}

function markupBps(): number {
  const value = Number(process.env.GEN3IA_NUMBER_MARKUP_BPS ?? DEFAULT_MARKUP_BPS);
  return Number.isSafeInteger(value) && value >= 0 && value <= 10_000 ? value : DEFAULT_MARKUP_BPS;
}

/** Marge 20 % : arrondie au cent supérieur (jamais de vente à perte). */
export function computeSellPriceUsdMinor(providerPriceUsdMinor: number, bps = markupBps()): number {
  return Math.ceil((providerPriceUsdMinor * (10_000 + bps)) / 10_000);
}

export function usdMinorToWalletMinor(usdMinor: number): number {
  const rate = Number(process.env.GEN3IA_USD_TO_XAF ?? DEFAULT_USD_TO_XAF);
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_USD_TO_XAF;
  return Math.ceil(usdMinor * safeRate);
}

function authHeader(accountSid: string, authToken: string): string {
  return "Basic " + Buffer.from(accountSid + ":" + authToken).toString("base64");
}

async function fetchTwilioMonthlyPriceUsdMinor(country: string): Promise<number | null> {
  const config = getTwilioConfig();
  const response = await fetch(
    `https://pricing.twilio.com/v1/PhoneNumbers/Countries/${encodeURIComponent(country.trim().toUpperCase())}`,
    {
      headers: { Authorization: authHeader(config.accountSid, config.authToken) },
      signal: AbortSignal.timeout(8_000),
    },
  ).catch(() => null);
  if (!response || !response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    phone_number_prices?: Array<{ number_type?: string; current_price?: number | string; base_price?: number | string }>;
  } | null;
  const prices = payload?.phone_number_prices;
  if (!Array.isArray(prices)) return null;
  const local = prices.find((price) => String(price.number_type ?? "").toLowerCase() === "local")
    ?? prices.find((price) => Number(price.current_price ?? price.base_price ?? 0) > 0);
  if (!local) return null;
  const usd = Number(local.current_price ?? local.base_price ?? 0);
  if (!Number.isFinite(usd) || usd <= 0) return null;
  return Math.ceil(usd * 100);
}

const PRICING_CACHE_TTL_SECONDS = 24 * 60 * 60;

/**
 * Tarification complète d'un numéro local du pays demandé — prix
 * fournisseur réel (cache Redis 24 h) + marge configurée.
 */
export async function getNumberPricing(country: string): Promise<NumberPricing> {
  const normalized = country.trim().toUpperCase();
  const cacheKey = `voice:pricing:${normalized}`;
  const bps = markupBps();

  const cached = await cacheGet<NumberPricing>(cacheKey);
  if (cached && cached.providerPriceUsdMinor > 0) {
    return { ...cached, markupBps: bps, sellPriceUsdMinor: computeSellPriceUsdMinor(cached.providerPriceUsdMinor, bps) };
  }

  let providerPriceUsdMinor: number | null = null;
  let source: NumberPricing["source"] = "fallback-configuration";
  try {
    providerPriceUsdMinor = await fetchTwilioMonthlyPriceUsdMinor(normalized);
    if (providerPriceUsdMinor) source = "twilio-pricing-api";
  } catch {
    providerPriceUsdMinor = null;
  }
  if (!providerPriceUsdMinor) {
    providerPriceUsdMinor = FALLBACK_PROVIDER_USD_MINOR;
  }

  const pricing: NumberPricing = {
    providerPriceUsdMinor,
    sellPriceUsdMinor: computeSellPriceUsdMinor(providerPriceUsdMinor, bps),
    markupBps: bps,
    currency: "USD",
    source,
  };

  // Cache y compris le fallback (24 h) : évite de marteler l'API Pricing
  // si un pays n'est pas desservi.
  await cacheSet(cacheKey, pricing, PRICING_CACHE_TTL_SECONDS);

  return pricing;
}
