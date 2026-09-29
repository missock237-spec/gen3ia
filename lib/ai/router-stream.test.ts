import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AIRequest, AIResponse } from "./models";

/**
 * Tests du coupe-circuit sur le chemin STREAMÉ (Task 45, anomalie A6) :
 * generateStream doit sauter un fournisseur en incident rafale, réussir sur
 * le suivant, et tenir à jour les compteurs de résilience.
 */

const { callProviderStreamMock, callProviderMock } = vi.hoisted(() => ({
  callProviderStreamMock: vi.fn(),
  callProviderMock: vi.fn(),
}));

vi.mock("./providers", () => ({
  callProvider: callProviderMock,
  callProviderStream: callProviderStreamMock,
}));

beforeEach(async () => {
  process.env.GROQ_API_KEY = "test-groq";
  process.env.OPENAI_API_KEY = "test-openai";
  process.env.OPENROUTER_API_KEY = "test-openrouter";
  // Les coupe-circuits sont en mémoire de module : état sain avant chaque test.
  const { recordProviderSuccess } = await import("./resilience");
  recordProviderSuccess("openai");
  recordProviderSuccess("groq");
  recordProviderSuccess("openrouter");
  callProviderStreamMock.mockReset();
  callProviderMock.mockReset();
});

const loadModule = async () => await import("./router");
const loadResilience = async () => await import("./resilience");

function request(overrides: Partial<AIRequest>): AIRequest {
  return {
    task: "chat",
    messages: [{ role: "user", content: "Bonjour" }],
    provider: "openai" as AIRequest["provider"],
    ...overrides,
  };
}

function streamResponse(provider: string): AIResponse {
  return {
    id: `id-${provider}`,
    provider: provider as AIResponse["provider"],
    model: "model-test",
    text: "Réponse",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

describe("generateStream — coupe-circuit (anomalie A6)", () => {
  it("saute un fournisseur au circuit ouvert et réussit sur le suivant", async () => {
    const { generateStream } = await loadModule();
    const { recordProviderFailure } = await loadResilience();

    // Incidents rafale sur openai : le circuit s'ouvre (seuil = 3 échecs).
    recordProviderFailure("openai");
    recordProviderFailure("openai");
    recordProviderFailure("openai");

    callProviderStreamMock.mockImplementation(async (provider: string) => {
      return streamResponse(provider);
    });

    const response = await generateStream(request({}), {
      onDelta: () => undefined,
    });

    // openai (préféré, circuit ouvert) n'a PAS été appelé ; le suivant oui.
    expect(callProviderStreamMock.mock.calls.map((call) => call[0])).not.toContain("openai");
    expect(callProviderStreamMock.mock.calls.length).toBeGreaterThan(0);
    expect(response.text).toBe("Réponse");
  });

  it("enregistre l'échec d'un fournisseur dont le stream n'a pas démarré (ouverture après seuil)", async () => {
    const { generateStream } = await loadModule();
    const { isProviderAvailable } = await loadResilience();

    callProviderStreamMock.mockImplementation(async (provider: string) => {
      if (provider === "openai") throw new Error("boom stream");
      return streamResponse(provider);
    });

    // Le circuit s'ouvre après 3 échecs consécutifs (seuil de résilience).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await generateStream(request({}), { onDelta: () => undefined });
      expect(response.provider).not.toBe("openai");
    }
    // Le fournisseur défaillant a été marqué en échec par generateStream.
    expect(isProviderAvailable("openai")).toBe(false);
  });

  it("réussit sur le premier fournisseur et enregistre le succès", async () => {
    const { generateStream } = await loadModule();
    const { isProviderAvailable } = await loadResilience();

    callProviderStreamMock.mockImplementation(async (provider: string) => streamResponse(provider));

    const response = await generateStream(request({}), {
      onDelta: () => undefined,
    });

    expect(response.provider).toBe("openai");
    expect(isProviderAvailable("openai")).toBe(true);
    expect(callProviderStreamMock).toHaveBeenCalledTimes(1);
  });
});
