import { describe, expect, it } from "vitest";

import { formatMoney, formatXAF, formatXAFShort } from "./money";

/**
 * Verrou du LOT UX D4 : le XAF n'a PAS de décimales (ISO 4217). L'ancien
 * affichage manuel `(amountMinor / 100).toLocaleString()` produisait
 * « 12,5 XAF » — régression interdite. Les séparateurs (espace insécable
 * étroite U+202F selon ICU) sont normalisés pour des assertions stables.
 */
const norm = (value: string) => value.replace(/[\u00a0\u202f]/g, " ").trim();

describe("formatXAF", () => {
  it("affiche un prix ENTIER (XAF = 0 décimale) : l'ancien bug « 12,5 XAF » est corrigé", () => {
    expect(norm(formatXAF(1250))).toMatch(/^13 (FCFA|XAF)$/);
    expect(norm(formatXAF(1250))).not.toContain(",");
  });

  it("convertit les unités mineures (centimes) vers le montant principal", () => {
    expect(norm(formatXAF(125000))).toMatch(/^1 250 (FCFA|XAF)$/);
    expect(norm(formatXAF(500000))).toMatch(/^5 000 (FCFA|XAF)$/);
  });

  it("gère 0 et les entrées non finies (API partielle) sans planter", () => {
    expect(norm(formatXAF(0))).toMatch(/^0 (FCFA|XAF)$/);
    expect(norm(formatXAF(Number.NaN))).toMatch(/^0 (FCFA|XAF)$/);
    expect(norm(formatXAF(Number.POSITIVE_INFINITY))).toMatch(/^0 (FCFA|XAF)$/);
  });
});

describe("formatXAFShort", () => {
  it("compacte les grands montants pour les espaces restreints", () => {
    expect(norm(formatXAFShort(1250000))).toMatch(/^12,5 k (FCFA|XAF)$/);
    expect(norm(formatXAFShort(52000000))).toMatch(/^520 k (FCFA|XAF)$/);
  });
});

describe("formatMoney", () => {
  it("les devises à décimales gardent leur précision (EUR)", () => {
    expect(norm(formatMoney(1250, "EUR"))).toBe("12,50 €");
  });

  it("repli XAF quand la devise est absente (marché principal)", () => {
    expect(norm(formatMoney(500000))).toMatch(/^5 000 (FCFA|XAF)$/);
  });
});
