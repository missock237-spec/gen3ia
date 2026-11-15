import { describe, expect, it } from "vitest";

import {
  assembleMessages,
  clampOutputTokens,
  compressHistory,
  contextWindowForModel,
  estimateMessagesTokens,
  estimateTokens,
  DEFAULT_CONTEXT_WINDOW,
} from "./context-window";

describe("contextWindowForModel — registre de fenêtres", () => {
  it("reconnaît les familles de modèles longues", () => {
    expect(contextWindowForModel("claude-sonnet-4-5")).toBe(200_000);
    expect(contextWindowForModel("gpt-4o-mini")).toBe(128_000);
    expect(contextWindowForModel("llama-3.3-70b-versatile")).toBe(128_000);
    expect(contextWindowForModel("glm-4.6")).toBe(128_000);
    expect(contextWindowForModel("gemini-2.0-flash")).toBe(1_000_000);
  });

  it("retourne un fallback conservateur pour un modèle inconnu", () => {
    expect(contextWindowForModel("modèle-exotique-v9")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowForModel(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowForModel("")).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe("clampOutputTokens — borne de sortie", () => {
  it("borne à la moitié de la fenêtre", () => {
    expect(clampOutputTokens("claude-sonnet-4-5", 500_000)).toBe(100_000);
    expect(clampOutputTokens("gpt-4o", 200_000)).toBe(64_000);
  });

  it("garde un plancher de 512 et un défaut sain", () => {
    expect(clampOutputTokens("gpt-4", 64)).toBe(512);
    expect(clampOutputTokens("gpt-4o", undefined)).toBe(8_192);
  });
});

describe("estimateTokens — heuristique", () => {
  it("estime ~1 token pour 3.2 caractères", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcdefgh")).toBe(3);
  });
});

describe("compressHistory — budget d'historique", () => {
  const history = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `Message ${index + 1} : ${"contenu substantiel ".repeat(12)}`,
  }));

  it("ne transforme RIEN quand tout tient dans le budget", () => {
    const result = compressHistory(history.slice(0, 4), { budgetTokens: 100_000 });
    expect(result.compressed).toBe(false);
    expect(result.messages).toHaveLength(4);
    expect(result.condensed).toBe(0);
  });

  it("condense les anciens et garde les récents verbatim quand ça déborde", () => {
    const result = compressHistory(history, { budgetTokens: 2_500, keepRecent: 6 });
    expect(result.compressed).toBe(true);
    expect(result.messages.some((m) => m.role === "system" && m.content.includes("Résumé des échanges"))).toBe(true);
    // Les 6 derniers messages sont conservés à l'identique.
    const tail = result.messages.slice(-6);
    expect(tail.map((m) => m.content)).toEqual(history.slice(-6).map((m) => m.content));
    expect(result.condensed).toBeGreaterThan(0);
    // Le digest ne contient que des sous-chaînes littérales (anti-invention).
    const digest = result.messages[0].content;
    expect(digest).toContain("Message 1");
  });

  it("tient toujours au moins le message le plus récent (budget délirant)", () => {
    const result = compressHistory(history, { budgetTokens: 120, keepRecent: 6 });
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.compressed).toBe(true);
  });

  it("l'estimation finale respecte le budget (marge 0.8)", () => {
    const result = compressHistory(history, { budgetTokens: 3_000, keepRecent: 8 });
    expect(result.estimatedTokens).toBeLessThanOrEqual(3_000);
  });
});

describe("assembleMessages — assemblage complet", () => {
  it("place system, historique compressé et message final", () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `échange ${i} ${"texte ".repeat(30)}`,
    }));
    const { messages, compressed } = assembleMessages({
      system: "Tu es un agent.",
      history,
      message: "Résume notre discussion.",
      model: "claude-sonnet-4-5",
      reservedOutputTokens: 3_000,
    });
    expect(messages[0].role).toBe("system");
    expect(messages[messages.length - 1].content).toBe("Résume notre discussion.");
    expect(messages[messages.length - 1].role).toBe("user");
    expect(estimateMessagesTokens(messages)).toBeLessThan(200_000);
    expect(compressed.estimatedTokens).toBeGreaterThan(0);
  });

  it("l'historique vide produit system + message uniquement", () => {
    const { messages } = assembleMessages({ system: "S", history: [], message: "M" });
    expect(messages).toHaveLength(2);
  });
});
