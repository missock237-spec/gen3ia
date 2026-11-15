import type { ExtensionManifest } from "./manifest";

/**
 * Extension pricing rules (pure): access gating and revenue splitting.
 * The frontend is NEVER treated as proof of payment — entitlements are only
 * created server-side (wallet settlement or verified Chariow webhook).
 */

export interface PricingInfo {
  model: "free" | "one_time" | "subscription" | "usage";
  amountMinor?: number;
  unitAmountMinor?: number;
  currency?: string;
  interval?: "month" | "year";
  maxExecutionsPerDay?: number;
}

export interface EntitlementInfo {
  status?: string;
  source?: string;
  expiresAt?: number | null;
}

export const DEFAULT_PLATFORM_FEE_BPS = Number(process.env.EXTENSION_PLATFORM_FEE_BPS ?? 2_000);
export const DEFAULT_DAILY_EXECUTION_LIMIT = Number(process.env.EXTENSION_DAILY_EXECUTION_LIMIT ?? 200);

export function pricingFromManifest(manifest: ExtensionManifest): PricingInfo {
  return manifest.pricing;
}

/** True when the user may execute this extension right now. */
export function canUseExtension(
  pricing: PricingInfo,
  entitlement: EntitlementInfo | null,
  now = Date.now(),
): { allowed: boolean; reason?: string } {
  if (pricing.model === "free") return { allowed: true };
  if (!entitlement) return { allowed: false, reason: "This extension requires a purchase." };
  if (entitlement.status !== "active") {
    return { allowed: false, reason: "Your entitlement for this extension is not active." };
  }
  if (typeof entitlement.expiresAt === "number" && entitlement.expiresAt <= now) {
    return { allowed: false, reason: "Your subscription to this extension has expired." };
  }
  return { allowed: true };
}

/** Subscription expiry timestamp (30 days per month, 365 per year). */
export function subscriptionExpiry(interval: "month" | "year", from = Date.now()): number {
  return from + (interval === "month" ? 30 : 365) * 24 * 60 * 60 * 1000;
}

export function computeUsageChargeMinor(pricing: PricingInfo, executions: number): number {
  if (pricing.model !== "usage" || !pricing.unitAmountMinor) return 0;
  return pricing.unitAmountMinor * Math.max(0, Math.floor(executions));
}

export interface RevenueSplit {
  grossAmountMinor: number;
  feeMinor: number;
  netAmountMinor: number;
}

/** Splits a purchase between the platform and the developer. */
export function computeRevenueSplit(
  grossAmountMinor: number,
  feeBps = DEFAULT_PLATFORM_FEE_BPS,
): RevenueSplit {
  if (!Number.isSafeInteger(grossAmountMinor) || grossAmountMinor < 0) {
    throw new Error("Gross amount must be a non-negative integer in minor units.");
  }
  const feeMinor = Math.round((grossAmountMinor * feeBps) / 10_000);
  return { grossAmountMinor, feeMinor, netAmountMinor: grossAmountMinor - feeMinor };
}

/** Effective daily execution cap for an installation. */
export function dailyExecutionLimit(pricing: PricingInfo): number {
  const declared = pricing.maxExecutionsPerDay ?? DEFAULT_DAILY_EXECUTION_LIMIT;
  return Math.min(declared, DEFAULT_DAILY_EXECUTION_LIMIT);
}

/** UTC day bucket used by usage counters (e.g. 2026-09-17). */
export function usageDayBucket(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}
