import { describe, expect, it } from "vitest";

import { costFromAIResponse, estimateExecutionCost } from "./cost-engine";

describe("estimateExecutionCost", () => {
  it("facture au minimum GEN3IA_MIN_EXECUTION_CHARGE_EUR (1 minor) pour une execution vide", () => {
    const result = estimateExecutionCost({ task: "chat" });
    expect(result.chargeMinor).toBeGreaterThanOrEqual(1);
    expect(result.reserveMinor).toBeGreaterThanOrEqual(result.chargeMinor);
  });

  it("calcule le cout fournisseur sur les tarifs par defaut (openai 2.5 EUR in / 10 EUR out par million)", () => {
    const result = estimateExecutionCost({ task: "chat", provider: "openai", inputTokens: 1_000_000, outputTokens: 0, complexity: 0.5 });
    // complexite 0.5 * multiplicateur chat 1 = 0.5
    // cout brut = 2.5 EUR + overhead plateforme ~0.0005 → * 0.5
    expect(result.providerCostEur).toBeCloseTo(2.5, 5);
    expect(result.complexityMultiplier).toBeCloseTo(0.5, 5);
    expect(result.chargeEur).toBeGreaterThan(0);
  });

  it("applique le tarif cache aux tokens caches et le tarif normal au reste", () => {
    const base = estimateExecutionCost({ task: "chat", provider: "openai", inputTokens: 1_000_000, complexity: 0.5 });
    const cached = estimateExecutionCost({ task: "chat", provider: "openai", inputTokens: 1_000_000, cachedInputTokens: 1_000_000, complexity: 0.5 });
    // Sans tarif cache configure, cachedInputEurPer1M retombe sur inputEurPer1M : meme prix.
    expect(cached.providerCostEur).toBeCloseTo(base.providerCostEur, 5);
  });

  it("borne la complexite entre 0.5 et 5", () => {
    const low = estimateExecutionCost({ task: "chat", complexity: 0.01 });
    const high = estimateExecutionCost({ task: "chat", complexity: 100 });
    expect(low.complexityMultiplier).toBeCloseTo(0.5, 5);
    expect(high.complexityMultiplier).toBeCloseTo(5, 5);
  });

  it("ignore les valeurs negatives en les ramenant a zero", () => {
    const result = estimateExecutionCost({ task: "chat", inputTokens: -500, outputTokens: -1, storageBytes: -10, networkBytes: -3, externalToolCostEur: -2, complexity: -4 });
    expect(result.providerCostEur).toBeGreaterThanOrEqual(0);
    expect(result.externalToolCostEur).toBe(0);
    expect(result.chargeMinor).toBeGreaterThanOrEqual(1);
  });

  it("majore la reserve selon GEN3IA_RESERVE_MULTIPLIER (>= charge)", () => {
    const result = estimateExecutionCost({ task: "agent", provider: "groq", inputTokens: 100_000, outputTokens: 50_000, complexity: 2 });
    expect(result.reserveEur).toBeGreaterThanOrEqual(result.chargeEur);
    expect(result.reserveMinor).toBeGreaterThanOrEqual(result.chargeMinor);
  });

  it("integre les couts outils externes et appels", () => {
    const withoutTools = estimateExecutionCost({ task: "chat", complexity: 1 });
    const withTools = estimateExecutionCost({ task: "chat", complexity: 1, externalToolCostEur: 0.5, toolCalls: 3 });
    expect(withTools.chargeEur).toBeGreaterThan(withoutTools.chargeEur);
    expect(withTools.externalToolCostEur).toBe(0.5);
  });

  it("retombe sur les tarifs par defaut si GEN3IA_MODEL_PRICING_JSON est invalide", () => {
    process.env.GEN3IA_MODEL_PRICING_JSON = "pas-du-json";
    const result = estimateExecutionCost({ task: "chat", provider: "openai", inputTokens: 1_000_000, complexity: 0.5 });
    expect(result.providerCostEur).toBeCloseTo(2.5, 5);
    delete process.env.GEN3IA_MODEL_PRICING_JSON;
  });

  it("honore un tarif modele valide depuis GEN3IA_MODEL_PRICING_JSON", () => {
    process.env.GEN3IA_MODEL_PRICING_JSON = JSON.stringify([
      { provider: "openai", model: "gpt-test", inputEurPer1M: 1, outputEurPer1M: 2 },
    ]);
    const result = estimateExecutionCost({ task: "chat", provider: "openai", model: "gpt-test", inputTokens: 1_000_000, outputTokens: 1_000_000, complexity: 0.5 });
    expect(result.providerCostEur).toBeCloseTo(3, 5);
    delete process.env.GEN3IA_MODEL_PRICING_JSON;
  });

  it("ecarte un tarif environnemental non fini (evite NaN dans la reserve)", () => {
    process.env.GEN3IA_MODEL_PRICING_JSON = JSON.stringify([
      { provider: "groq", model: "broken", inputEurPer1M: "NaN", outputEurPer1M: 1 },
    ]);
    const result = estimateExecutionCost({ task: "chat", provider: "groq", model: "broken", inputTokens: 1_000_000, complexity: 0.5 });
    expect(Number.isFinite(result.chargeEur)).toBe(true);
    expect(Number.isFinite(result.reserveEur)).toBe(true);
    delete process.env.GEN3IA_MODEL_PRICING_JSON;
  });
});

describe("costFromAIResponse", () => {
  it("facture la reponse IA a partir de son usage declare", () => {
    const charge = costFromAIResponse(
      { task: "chat", messages: [] } as Parameters<typeof costFromAIResponse>[0],
      {
        provider: "openai",
        model: "gpt-x",
        text: "ok",
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        latencyMs: 100,
      } as Parameters<typeof costFromAIResponse>[1],
    );
    expect(charge.chargeMinor).toBeGreaterThan(0);
    expect(Number.isFinite(charge.chargeEur)).toBe(true);
  });
});
