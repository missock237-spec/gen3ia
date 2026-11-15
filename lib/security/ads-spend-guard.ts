import { z } from "zod";

export const ADS_PROVIDERS = ["google_ads", "meta_ads", "tiktok_ads"] as const;
export type AdsProvider = (typeof ADS_PROVIDERS)[number];

const MAX_DECLARED_LIMIT_MINOR = 100_000_000;
const MONEY_KEYS = /(^|_)(budget|spend|cost|amount|daily_budget|lifetime_budget|bid)(_|$)/i;

const AdsSpendInputSchema = z.object({
  provider: z.enum(ADS_PROVIDERS),
  toolSlug: z.string().regex(/^[A-Z0-9_:-]{3,200}$/i),
  accountId: z.string().min(1).max(256),
  maxAdSpendMinor: z.number().int().positive().max(MAX_DECLARED_LIMIT_MINOR),
  currency: z.string().regex(/^[A-Z]{3}$/),
  arguments: z.record(z.string(), z.unknown()),
});

function walkMoneyFields(value: unknown, path = ""): Array<{ path: string; value: number }> {
  const found: Array<{ path: string; value: number }> = [];
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...walkMoneyFields(item, `${path}[${index}]`)));
    return found;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (MONEY_KEYS.test(key) && typeof item === "number" && Number.isFinite(item)) {
      found.push({ path: nextPath, value: item });
    }
    found.push(...walkMoneyFields(item, nextPath));
  }
  return found;
}

export function assertAdsSpendPolicy(input: Record<string, unknown>): void {
  const parsed = AdsSpendInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid Ads spend policy: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);

  if (parsed.data.currency !== "EUR") {
    throw new Error("External Ads spend controls currently require EUR. Configure a currency conversion service before enabling another currency.");
  }

  for (const field of walkMoneyFields(parsed.data.arguments)) {
    if (field.value < 0) throw new Error(`Negative Ads monetary value is forbidden: ${field.path}`);
    if (field.value > parsed.data.maxAdSpendMinor) {
      throw new Error(`Ads monetary field ${field.path} exceeds the approved external spend ceiling.`);
    }
  }
}

export function getAdsSpendCeiling(input: Record<string, unknown>): number {
  const parsed = AdsSpendInputSchema.parse(input);
  return parsed.maxAdSpendMinor;
}
