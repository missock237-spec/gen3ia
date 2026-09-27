import { describe, expect, it } from "vitest";

import { detectLanguage, isPromptAlreadyStructured } from "./prompt-enhancer";

describe("prompt-enhancer — chemins rapides déterministes", () => {
  it("les prompts déjà structurés passent sans appel LLM (rapidité)", () => {
    const structured = [
      "Objectif : lancer une campagne marketing.",
      "Étapes :",
      "1. Analyser la cible",
      "2. Rédiger les messages",
      "Livrable : un plan complet avec calendrier.",
    ].join("\n");
    expect(isPromptAlreadyStructured(structured)).toBe(true);
  });

  it("un prompt court et informel n'est pas considéré comme structuré", () => {
    expect(isPromptAlreadyStructured("fais moi un logo")).toBe(false);
  });

  it("détecte la langue française et anglaise", () => {
    expect(detectLanguage("Crée une page web pour ma boulangerie")).toBe("fr");
    expect(detectLanguage("Create a landing page for my bakery")).toBe("en");
  });
});
