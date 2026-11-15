import { describe, expect, it } from "vitest";
import { blocksFromMarkdown } from "./document-engine";
import { extractJsonObject } from "./ai-engine";

describe("Document Engine — blocksFromMarkdown", () => {
  it("convertit titres, paragraphes, listes et citations", () => {
    const markdown = [
      "# Contrat de prestation",
      "",
      "Premier paragraphe sur une ligne.",
      "Suite du même paragraphe.",
      "",
      "## Obligations",
      "- Livrer sous 30 jours",
      "- Assurer la garantie",
      "",
      "1. Première étape",
      "2. Deuxième étape",
      "",
      "> Force majeure exceptée.",
    ].join("\n");

    const blocks = blocksFromMarkdown(markdown);
    expect(blocks).toEqual([
      { type: "title", text: "Contrat de prestation" },
      { type: "paragraph", text: "Premier paragraphe sur une ligne. Suite du même paragraphe." },
      { type: "heading", level: 2, text: "Obligations" },
      { type: "list", items: ["Livrer sous 30 jours", "Assurer la garantie"] },
      { type: "list", ordered: true, items: ["Première étape", "Deuxième étape"] },
      { type: "quote", text: "Force majeure exceptée." },
    ]);
  });

  it("convertit un tableau à barres en bloc table avec colonnes et lignes", () => {
    const markdown = ["| Article | Montant |", "| --- | --- |", "| Développement | 5 000 € |", "| Maintenance | 300 € |"].join("\n");
    const blocks = blocksFromMarkdown(markdown);
    expect(blocks).toEqual([
      { type: "table", columns: ["Article", "Montant"], rows: [["Développement", "5 000 €"], ["Maintenance", "300 €"]] },
    ]);
  });

  it("retombe sur un paragraphe unique pour du texte brut", () => {
    expect(blocksFromMarkdown("Juste du texte.")).toEqual([{ type: "paragraph", text: "Juste du texte." }]);
  });
});

describe("AI Engine — extractJsonObject", () => {
  it("extrait le JSON entouré de texte et de fences", () => {
    const raw = 'Voici le résultat :\n```json\n{"headline": "Test", "score": 9.5}\n```\nMerci.';
    expect(extractJsonObject(raw)).toEqual({ headline: "Test", score: 9.5 });
  });

  it("gère un JSON sans fence mais avec texte parasite", () => {
    expect(extractJsonObject('Réponse : {"a": [1, 2]} fin')).toEqual({ a: [1, 2] });
  });

  it("échoue proprement sans objet", () => {
    expect(() => extractJsonObject("pas de json ici")).toThrow(/Aucun objet JSON/);
  });
});
