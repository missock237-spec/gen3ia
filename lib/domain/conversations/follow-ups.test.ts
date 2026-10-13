import { describe, expect, it } from "vitest";

import { buildFollowUpSuggestions, MAX_FOLLOW_UPS } from "./follow-ups";

/**
 * Task 141 — suggestions de suivi cliquables : verrous sur la fonction pure
 * buildFollowUpSuggestions (déterministe, zéro LLM). Les chips affichées sous
 * la dernière réponse doivent être courtes, pertinentes et jamais en double.
 */

describe("buildFollowUpSuggestions — forme de la réponse", () => {
  it("propose la conversion en graphique quand la réponse contient un tableau", () => {
    const suggestions = buildFollowUpSuggestions(
      "Analyse mes ventes",
      "Voici le tableau :\n\n| Mois | Ventes |\n|---|---|\n| Jan | 10 |\n",
    );
    expect(suggestions).toContain("Convertis ce tableau en graphique");
  });

  it("propose l'explication quand la réponse contient du code", () => {
    const suggestions = buildFollowUpSuggestions(
      "Écris une fonction",
      "```ts\nconst doubler = (x: number) => x * 2;\n```",
    );
    expect(suggestions).toContain("Explique ce code pas à pas");
  });

  it("propose le détail de la première étape quand la réponse est une liste numérotée", () => {
    const suggestions = buildFollowUpSuggestions(
      "Comment procéder ?",
      "Plan :\n1. Première étape\n2. Deuxième étape\n",
    );
    expect(suggestions).toContain("Détaille la première étape avec un exemple");
  });

  it("propose la recherche croisée quand la réponse cite ses sources", () => {
    const suggestions = buildFollowUpSuggestions("Veille marché", "Analyse…\n\nSources : rapport 2024");
    expect(suggestions).toContain("Croise avec une recherche web plus récente");
  });
});

describe("buildFollowUpSuggestions — message d'origine", () => {
  it("propose le PDF quand l'utilisateur a demandé un rapport", () => {
    const suggestions = buildFollowUpSuggestions("Fais-moi un rapport de ventes", "Voici le rapport…");
    expect(suggestions).toContain("Transforme-le en document PDF prêt à partager");
  });

  it("propose le mail de suivi quand le message parle d'un mail", () => {
    const suggestions = buildFollowUpSuggestions("Prépare un mail de relance", "Voici le texte…");
    expect(suggestions).toContain("Rédige le mail de suivi prêt à envoyer");
  });

  it("propose la traduction quand le message demande une traduction", () => {
    const suggestions = buildFollowUpSuggestions("Traduis ce paragraphe en français", "Voici la traduction…");
    expect(suggestions).toContain("Traduis-le aussi en anglais");
  });
});

describe("buildFollowUpSuggestions — invariants", () => {
  it("retourne au plus MAX_FOLLOW_UPS suggestions", () => {
    const suggestions = buildFollowUpSuggestions(
      "Fais un rapport avec un mail et un tableau pour ma veille",
      "Tableau :\n|---|\n\n1. Étape\n2. Étape\n\nSources : web",
    );
    expect(suggestions.length).toBeLessThanOrEqual(MAX_FOLLOW_UPS);
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it("ne retourne jamais de doublon (insensible à la casse)", () => {
    const suggestions = buildFollowUpSuggestions("rapport", "| a |\n|---|\n| 1 |");
    const lowered = suggestions.map((s) => s.toLowerCase());
    expect(new Set(lowered).size).toBe(suggestions.length);
  });

  it("retombe sur des suggestions génériques pour un message et une réponse neutres", () => {
    const suggestions = buildFollowUpSuggestions("Bonjour", "Bonjour ! Comment puis-je vous aider ?");
    expect(suggestions.length).toBe(MAX_FOLLOW_UPS);
    expect(suggestions).toContain("Résume en 3 points essentiels");
  });

  it("ne retourne jamais de suggestion vide ou dépassant 120 caractères", () => {
    const suggestions = buildFollowUpSuggestions(
      "a".repeat(500),
      "b".repeat(5000),
    );
    for (const suggestion of suggestions) {
      expect(suggestion.trim().length).toBeGreaterThan(0);
      expect(suggestion.length).toBeLessThanOrEqual(120);
    }
  });

  it("tolère des entrées vides (réponse minimale)", () => {
    const suggestions = buildFollowUpSuggestions("", "");
    expect(suggestions.length).toBeGreaterThan(0);
  });
});
