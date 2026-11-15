import { describe, expect, it } from "vitest";
import { assertAdsSpendPolicy } from "./ads-spend-guard";

const base = {
  provider: "google_ads" as const,
  toolSlug: "GOOGLEADS_CREATE_CAMPAIGN",
  accountId: "connected-account-1",
  maxAdSpendMinor: 5000,
  currency: "EUR",
};

describe("Ads spend guard", () => {
  it("accepts a declared ceiling and matching provider payload", () => {
    expect(() => assertAdsSpendPolicy({ ...base, arguments: { daily_budget: 5000 } })).not.toThrow();
  });

  it("rejects a provider budget above the approved ceiling", () => {
    expect(() => assertAdsSpendPolicy({ ...base, arguments: { daily_budget: 5001 } })).toThrow(/exceeds the approved/);
  });

  it("requires an explicit connected account and spend ceiling", () => {
    expect(() => assertAdsSpendPolicy({ ...base, accountId: "", arguments: {} })).toThrow();
    expect(() => assertAdsSpendPolicy({ ...base, maxAdSpendMinor: undefined, arguments: {} })).toThrow();
  });

  it("rejects non-EUR until FX conversion is explicitly implemented", () => {
    expect(() => assertAdsSpendPolicy({ ...base, currency: "USD", arguments: {} })).toThrow(/currency conversion/);
  });
});
