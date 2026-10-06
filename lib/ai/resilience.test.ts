import { afterEach, describe, expect, it } from "vitest";

import {
  forceCooldownElapsed,
  getBreakerSnapshot,
  isProviderAvailable,
  openProviderCount,
  recordProviderFailure,
  recordProviderSuccess,
  resetBreakers,
} from "./resilience";

afterEach(() => resetBreakers());

describe("coupe-circuit par fournisseur", () => {
  it("fermé par défaut : tout passe", () => {
    expect(isProviderAvailable("groq")).toBe(true);
    expect(openProviderCount()).toBe(0);
  });

  it("s'ouvre après le seuil d'échecs consécutifs", () => {
    for (let i = 0; i < 3; i++) recordProviderFailure("groq");
    expect(isProviderAvailable("groq")).toBe(false);
    expect(openProviderCount()).toBe(1);
    expect(isProviderAvailable("openai")).toBe(true);
    expect(getBreakerSnapshot("groq")?.state).toBe("open");
  });

  it("un succès réinitialise le compteur", () => {
    recordProviderFailure("groq");
    recordProviderFailure("groq");
    recordProviderSuccess("groq");
    recordProviderFailure("groq");
    recordProviderFailure("groq");
    expect(isProviderAvailable("groq")).toBe(true);
  });

  it("half-open : une seule sonde après cooldown", () => {
    for (let i = 0; i < 3; i++) recordProviderFailure("glm");
    forceCooldownElapsed("glm");

    expect(isProviderAvailable("glm")).toBe(true); // sonde autorisée
    expect(isProviderAvailable("glm")).toBe(false); // sonde en cours : refusé
    recordProviderSuccess("glm");
    expect(isProviderAvailable("glm")).toBe(true);
    expect(getBreakerSnapshot("glm")?.state).toBe("closed");
  });

  it("half-open : la sonde qui échoue rouvre le circuit", () => {
    for (let i = 0; i < 3; i++) recordProviderFailure("openrouter");
    forceCooldownElapsed("openrouter");

    expect(isProviderAvailable("openrouter")).toBe(true);
    recordProviderFailure("openrouter");
    expect(isProviderAvailable("openrouter")).toBe(false);
    expect(getBreakerSnapshot("openrouter")?.state).toBe("open");
  });

  it("cooldown croissant (backoff exponentiel borné)", () => {
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 3; i++) recordProviderFailure("anthropic");
      forceCooldownElapsed("anthropic");
      isProviderAvailable("anthropic"); // consomme la sonde half-open
      recordProviderFailure("anthropic");
    }
    const snapshot = getBreakerSnapshot("anthropic");
    expect(snapshot?.cooldownMs).toBeLessThanOrEqual(5 * 60_000);
    expect(snapshot?.cooldownMs).toBeGreaterThan(30_000);
  });

  it("un fournisseur jamais vu n'a pas d'instantané", () => {
    // « agnes » n'est utilisé par aucun autre test de ce fichier (audit
    // médias 103-c : « huggingface » retiré de AIProvider — provider mort).
    expect(getBreakerSnapshot("agnes")).toBeNull();
  });
});
