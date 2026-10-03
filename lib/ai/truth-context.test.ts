import { describe, expect, it } from "vitest";
import { cleanRequestedResult, formatTruthContext } from "@/lib/ai/truth-context";

describe("truth context", () => {
  it("keeps only the requested result wrapper-free", () => {
    expect(cleanRequestedResult("Voici, le résultat demandé.\n\n")).toBe("le résultat demandé.");
  });

  it("formats recent history and semantic memory separately", () => {
    const output = formatTruthContext({
      instructions: "GROUNDING",
      recent: [{ role: "user", content: "Créer une affiche." }],
      semantic: [{
        conversationId: "c1",
        role: "user",
        preview: "Style minimaliste",
        score: 0.81,
        createdAt: "2026-10-03T00:00:00.000Z",
      }],
    });
    expect(output).toContain("ÉCHANGES RÉCENTS:");
    expect(output).toContain("HISTORIQUE SÉMANTIQUE:");
    expect(output).toContain("Style minimaliste");
  });
});
