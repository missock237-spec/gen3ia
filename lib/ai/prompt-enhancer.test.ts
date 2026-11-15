import { describe, expect, it } from "vitest";

import { detectLanguage, isPromptAlreadyStructured, languageDirective } from "./prompt-enhancer";

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
});

describe("detectLanguage — détection robuste (audit : trop de « autre »)", () => {
  it("détecte le français et l'anglais (cas historiques)", () => {
    expect(detectLanguage("Crée une page web pour ma boulangerie")).toBe("fr");
    expect(detectLanguage("Create a landing page for my bakery")).toBe("en");
  });

  it("détecte le français SANS verbe d'action (l'ancien gabarit renvoyait « autre »)", () => {
    expect(detectLanguage("Donne-moi le rapport de l'équipe, s'il te plaît")).toBe("fr");
    expect(detectLanguage("Voici mon besoin : un site très rapide et bien référencé")).toBe("fr");
    expect(detectLanguage("Quel est le prix de l'abonnement mensuel ?")).toBe("fr");
    expect(detectLanguage("Merci beaucoup pour ton aide, c'est très clair")).toBe("fr");
  });

  it("détecte l'anglais courant", () => {
    expect(detectLanguage("Please analyze the sales data and send me a summary")).toBe("en");
    expect(detectLanguage("What is the best plan for my team?")).toBe("en");
    expect(detectLanguage("Can you write a report from these numbers?")).toBe("en");
  });

  it("utilise les caractères accentués comme signe fort (égalité de mots vides)", () => {
    expect(detectLanguage("Déjà vérifié, résulé...")).toBe("fr");
    expect(detectLanguage("Hôtel réservé à Séville")).toBe("fr");
  });

  it("renvoie other pour une langue non couverte ou un message sans signal", () => {
    expect(detectLanguage("")).toBe("other");
    expect(detectLanguage("   ")).toBe("other");
    expect(detectLanguage("123 456")).toBe("other");
    expect(detectLanguage("こんにちは、元気ですか")).toBe("other");
    expect(detectLanguage("Hallo, wie geht es dir?")).toBe("other");
  });
});

describe("languageDirective — directive de langue impérative", () => {
  it("français détecté → directive française impérative", () => {
    const directive = languageDirective("Prépare-moi un résumé du marché");
    expect(directive).toBe("LANGUE : réponds impérativement en français (langue détectée du dernier message).");
  });

  it("anglais détecté → directive anglaise impérative (jamais de réponse française)", () => {
    const directive = languageDirective("Prepare a summary of the market for me");
    expect(directive).toBe("LANGUE : réponds impérativement en anglais (langue détectée du dernier message).");
  });

  it("langue non couverte → suivre la langue du dernier message", () => {
    expect(languageDirective("こんにちは")).toBe(
      "LANGUE : réponds dans la langue du dernier message de l'utilisateur.",
    );
    expect(languageDirective("")).toBe(
      "LANGUE : réponds dans la langue du dernier message de l'utilisateur.",
    );
  });
});
