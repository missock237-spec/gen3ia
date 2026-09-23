import { describe, expect, it } from "vitest";

import { assertSafeMemoryValue, evaluateDuplicateWrite, normalizeMemoryValue } from "./keyvalue";

describe("normalizeMemoryValue", () => {
  it("conserve les chaînes telles quelles", () => {
    expect(normalizeMemoryValue("Bonjour")).toBe("Bonjour");
    expect(normalizeMemoryValue(42)).toBe("42");
  });

  it("sérialise les objets pour une comparaison stable", () => {
    expect(normalizeMemoryValue({ a: 1 })).toBe(JSON.stringify({ a: 1 }));
  });

  it("rend la comparaison indépendante de l'ordre des clés (idempotence)", () => {
    expect(normalizeMemoryValue({ projet: "gen3ia", note: "v1" })).toBe(normalizeMemoryValue({ note: "v1", projet: "gen3ia" }));
  });

  it("trie les clés récursivement, y compris dans les objets imbriqués et les tableaux", () => {
    const a = { meta: { b: 2, a: 1 }, items: [{ y: 1, x: 2 }] };
    const b = { items: [{ x: 2, y: 1 }], meta: { a: 1, b: 2 } };
    expect(normalizeMemoryValue(a)).toBe(normalizeMemoryValue(b));
  });

  it("préserve l'ordre des tableaux (les listes sont significatives)", () => {
    expect(normalizeMemoryValue([1, 2])).not.toBe(normalizeMemoryValue([2, 1]));
  });
});

describe("assertSafeMemoryValue (garde-fou secrets, à ne pas casser)", () => {
  it("accepte une valeur normale", () => {
    expect(assertSafeMemoryValue("Préférence : réponses concises")).toBe("Préférence : réponses concises");
  });

  it("refusait déjà et refuse toujours les secrets", () => {
    expect(() => assertSafeMemoryValue("api_key: sk-abcdefghij0123456789")).toThrow(/credentials or secrets/);
    expect(() => assertSafeMemoryValue("password: SuperSecret123")).toThrow(/credentials or secrets/);
    expect(() => assertSafeMemoryValue("mon token bearer abcdefghijklmnopqrstuvwxyz")).toThrow(/credentials or secrets/);
    expect(() => assertSafeMemoryValue({ note: "secret: x".replace("x", "abcdefghijklmnopqrstu") })).toThrow(/credentials or secrets/);
  });

  it("refuse les valeurs vides", () => {
    expect(() => assertSafeMemoryValue("")).toThrow(/empty/);
    expect(() => assertSafeMemoryValue(undefined)).toThrow(/empty/);
  });

  it("refuse les valeurs trop volumineuses (> 50 Ko)", () => {
    expect(() => assertSafeMemoryValue("a".repeat(50_001))).toThrow(/size/);
  });
});

describe("evaluateDuplicateWrite (contrat de doublon)", () => {
  const base = { exists: true, existingValue: "Valeur actuelle", overwrite: false };

  it("écrit normalement une clé inexistante", () => {
    expect(evaluateDuplicateWrite({ ...base, exists: false, incomingValue: "peu importe" }).action).toBe("create");
  });

  it("traite une réécriture identique comme idempotente (200, aucune écriture)", () => {
    expect(evaluateDuplicateWrite({ ...base, incomingValue: "Valeur actuelle" }).action).toBe("identical");
    // Identité sémantique objet sérialisé ≠ référence mémoire.
    expect(evaluateDuplicateWrite({ ...base, existingValue: '{"a":1}', incomingValue: { a: 1 } }).action).toBe("identical");
  });

  it("signale un conflit quand la valeur diffère sans consentement (409)", () => {
    expect(evaluateDuplicateWrite({ ...base, incomingValue: "Autre valeur" }).action).toBe("conflict");
  });

  it("autorise l'écrasement uniquement avec un consentement explicite (overwrite)", () => {
    expect(evaluateDuplicateWrite({ ...base, incomingValue: "Autre valeur", overwrite: true }).action).toBe("create");
  });
});
