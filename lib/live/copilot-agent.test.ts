import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agent copilote visuel temps réel (agentHandler) :
 * garde d'entrée des questions, system prompt de spécification, streaming
 * fournisseur avec repli, abandon via AbortController.
 */

const createMock = vi.fn();

vi.mock("openai", () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: createMock } };
    constructor(public options: Record<string, unknown>) {}
  },
}));

import { answerCopilotAsk, assertCopilotAsk, COPILOT_SYSTEM_PROMPT } from "./copilot-agent";

function fakeStream(chunks: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield { choices: [{ delta: { content: chunk } }] };
      }
    },
  };
}

beforeEach(() => {
  createMock.mockReset();
  process.env.OPENROUTER_API_KEY = "test-openrouter";
  delete process.env.OPENAI_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.LIVE_COPILOT_MODEL;
});

describe("assertCopilotAsk", () => {
  it("normalise et accepte une question valide", () => {
    expect(assertCopilotAsk("  Que vois-tu sur mon écran ?  ")).toBe("Que vois-tu sur mon écran ?");
  });

  it("rejette les questions vides ou trop longues", () => {
    expect(() => assertCopilotAsk("   ")).toThrow();
    expect(() => assertCopilotAsk("x".repeat(4001))).toThrow();
  });
});

describe("COPILOT_SYSTEM_PROMPT", () => {
  it("porte la mission de copilote visuel temps réel et les garde-fous", () => {
    expect(COPILOT_SYSTEM_PROMPT).toContain("copilote visuel temps réel");
    expect(COPILOT_SYSTEM_PROMPT).toContain("captures d'écran");
    expect(COPILOT_SYSTEM_PROMPT).toContain("boutons, formulaires, erreurs, code, pages web");
    expect(COPILOT_SYSTEM_PROMPT).toContain("mot de passe");
  });
});

describe("answerCopilotAsk", () => {
  it("stream les fragments au client au fil de l'arrivée", async () => {
    createMock.mockResolvedValue(fakeStream(["Voici ", "le bouton ", "à cliquer."]));
    const deltas: string[] = [];
    const answer = await answerCopilotAsk(
      { question: "Où est le bouton Enregistrer ?", frame: { jpeg: Buffer.from("jpeg"), width: 1280, height: 720 }, history: [] },
      { onDelta: (text) => deltas.push(text) },
    );
    expect(answer).toBe("Voici le bouton à cliquer.");
    expect(deltas).toEqual(["Voici ", "le bouton ", "à cliquer."]);
    expect(createMock).toHaveBeenCalledTimes(1);
    const call = createMock.mock.calls[0][0] as { messages: { role: string; content: unknown }[]; stream: boolean };
    expect(call.stream).toBe(true);
    expect(call.messages[0]).toEqual({ role: "system", content: COPILOT_SYSTEM_PROMPT });
  });

  it("inclut la frame comme image base64 et la question", async () => {
    createMock.mockResolvedValue(fakeStream(["ok"]));
    await answerCopilotAsk(
      { question: "Q ?", frame: { jpeg: Buffer.from("frame-content"), width: 800, height: 600 }, history: [] },
      { onDelta: () => undefined },
    );
    const call = createMock.mock.calls[0][0] as { messages: { role: string; content: Array<Record<string, unknown>> }[] };
    const userContent = call.messages[call.messages.length - 1].content;
    expect(Array.isArray(userContent)).toBe(true);
    const image = (userContent as Array<Record<string, unknown>>).find((part) => part.type === "image_url");
    expect(image).toBeDefined();
    expect((image as { image_url: { url: string } }).image_url.url).toContain("data:image/jpeg;base64,");
    const texts = (userContent as Array<Record<string, unknown>>).filter((part) => part.type === "text").map((part) => String(part.text));
    expect(texts.some((text) => text.includes("Q ?"))).toBe(true);
  });

  it("repli fournisseur : OpenRouter en échec → next provider (OpenAI)", async () => {
    process.env.OPENAI_API_KEY = "test-openai";
    createMock
      .mockRejectedValueOnce(new Error("openrouter down"))
      .mockResolvedValueOnce(fakeStream(["Réponse ", "de secours."]));
    const answer = await answerCopilotAsk({ question: "Q ?", history: [] }, { onDelta: () => undefined });
    expect(answer).toBe("Réponse de secours.");
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("propage l'abandon (bouton Stop) sans tenter d'autres fournisseurs", async () => {
    const controller = new AbortController();
    createMock.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });
    const deltas: string[] = [];
    await expect(
      answerCopilotAsk(
        { question: "Q ?", history: [], signal: controller.signal },
        { onDelta: (text) => deltas.push(text) },
      ),
    ).rejects.toThrow();
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("erreur explicite si aucun fournisseur vision configuré", async () => {
    delete process.env.OPENROUTER_API_KEY;
    await expect(answerCopilotAsk({ question: "Q ?", history: [] }, { onDelta: () => undefined })).rejects.toThrow("Aucun fournisseur vision");
  });

  it("borne l'historique transmis (fenêtre glissante 8 tours)", async () => {
    createMock.mockResolvedValue(fakeStream(["ok"]));
    const history = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message ${index}`,
    }));
    await answerCopilotAsk({ question: "Q ?", history }, { onDelta: () => undefined });
    const call = createMock.mock.calls[0][0] as { messages: unknown[] };
    // system + 16 messages d'historique + question courante
    expect(call.messages.length).toBe(1 + 16 + 1);
  });
});
