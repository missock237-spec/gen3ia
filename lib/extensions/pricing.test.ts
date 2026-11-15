import { describe, expect, it } from "vitest";

import {
  canUseExtension,
  computeRevenueSplit,
  computeUsageChargeMinor,
  dailyExecutionLimit,
  subscriptionExpiry,
  usageDayBucket,
} from "./pricing";
import { validateSimpleRecord } from "./schema-validate";

describe("pricing & entitlements d'extensions", () => {
  it("autorise toujours les extensions gratuites", () => {
    expect(canUseExtension({ model: "free" }, null).allowed).toBe(true);
  });

  it("exige un entitlement actif pour une extension payante", () => {
    const paid = { model: "one_time" as const, amountMinor: 100000 };
    expect(canUseExtension(paid, null).allowed).toBe(false);
    expect(canUseExtension(paid, { status: "pending" }).allowed).toBe(false);
    expect(canUseExtension(paid, { status: "active" }).allowed).toBe(true);
  });

  it("expire les abonnements", () => {
    const sub = { model: "subscription" as const, amountMinor: 300000, interval: "month" as const };
    const now = Date.now();
    expect(canUseExtension(sub, { status: "active", expiresAt: now - 1000 }, now).allowed).toBe(false);
    expect(canUseExtension(sub, { status: "active", expiresAt: now + 1000 }, now).allowed).toBe(true);
  });

  it("calcule la répartition revenus avec commission plateforme", () => {
    const split = computeRevenueSplit(10_000, 2_000);
    expect(split).toEqual({ grossAmountMinor: 10_000, feeMinor: 2_000, netAmountMinor: 8_000 });
    expect(() => computeRevenueSplit(-1)).toThrow();
  });

  it("calcule la facturation à l'usage et le plafond quotidien", () => {
    expect(computeUsageChargeMinor({ model: "usage", unitAmountMinor: 25 }, 40)).toBe(1_000);
    expect(computeUsageChargeMinor({ model: "free" }, 40)).toBe(0);
    expect(dailyExecutionLimit({ model: "free", maxExecutionsPerDay: 50 })).toBe(50);
    expect(dailyExecutionLimit({ model: "free", maxExecutionsPerDay: 99_999 })).toBeLessThanOrEqual(200);
    expect(usageDayBucket()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(subscriptionExpiry("month") - subscriptionExpiry("month", 0)).toBeGreaterThan(0);
  });
});

describe("validation des entrées/sorties d'outils d'extension", () => {
  it("valide les champs requis et les types", () => {
    const fields = {
      ville: { type: "string" as const, required: true, maxLength: 10 },
      page: { type: "number" as const, min: 1 },
    };
    expect(validateSimpleRecord({ ville: "Douala", page: 2 }, fields)).toEqual([]);
    expect(validateSimpleRecord({ page: 2 }, fields).length).toBeGreaterThan(0);
    expect(validateSimpleRecord({ ville: "une-ville-beaucoup-trop-longue", page: 2 }, fields).length).toBeGreaterThan(0);
    expect(validateSimpleRecord({ ville: "ok", page: "deux" }, fields).length).toBeGreaterThan(0);
  });

  it("valide les enums, tableaux et objets imbriqués", () => {
    const fields = {
      langue: { type: "string" as const, enum: ["fr", "en"] },
      tags: { type: "array" as const, items: { type: "string" as const, maxLength: 4 }, max: 2 },
      meta: { type: "object" as const, properties: { ok: { type: "boolean" as const } } },
    };
    expect(validateSimpleRecord({ langue: "fr", tags: ["ab", "cd"], meta: { ok: true } }, fields)).toEqual([]);
    expect(validateSimpleRecord({ langue: "de" }, fields).length).toBeGreaterThan(0);
    expect(validateSimpleRecord({ tags: ["abcde"] }, fields).length).toBeGreaterThan(0);
    expect(validateSimpleRecord({ meta: { ok: "oui" } }, fields).length).toBeGreaterThan(0);
  });

  it("ignore la validation quand aucun schéma n'est déclaré", () => {
    expect(validateSimpleRecord({ tout: "est permis" }, undefined)).toEqual([]);
  });
});
