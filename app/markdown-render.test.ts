import { describe, expect, it } from "vitest";

import { parseMarkdownBlocks } from "@/lib/ui/markdown-blocks";

/**
 * Task 52 — rendu markdown des réponses « qualité ChatGPT » : le contrat de
 * présentation (lib/ai/response-quality.ts) autorise tableaux et séparateurs ;
 * ces tests vérifient que le parser les produit RÉELLEMENT (et que le reste
 * du parsing historique n'a pas régressé).
 */
describe("parseMarkdownBlocks — tableaux", () => {
  it("reconnaît un tableau standard | a | b | avec séparateur", () => {
    const blocks = parseMarkdownBlocks(
      [
        "Voici la comparaison :",
        "",
        "| Formule | Prix |",
        "|---|---|",
        "| Starter | 5 000 FCFA |",
        "| Pro | 12 000 FCFA |",
      ].join("\n"),
    );
    const table = blocks.find((block) => block.kind === "table");
    expect(table).toBeDefined();
    expect(table?.header).toEqual(["Formule", "Prix"]);
    expect(table?.rows).toEqual([
      ["Starter", "5 000 FCFA"],
      ["Pro", "12 000 FCFA"],
    ]);
  });

  it("accepte les alignements (:---) et les espaces irréguliers", () => {
    const blocks = parseMarkdownBlocks(
      [
        "| Critère | Sans |",
        "| :--- | ---: |",
        "| Délai | 2 jours |",
      ].join("\n"),
    );
    const table = blocks.find((block) => block.kind === "table");
    expect(table?.header).toEqual(["Critère", "Sans"]);
    expect(table?.rows).toEqual([["Délai", "2 jours"]]);
  });

  it("une ligne contenant un pipe SANS ligne de séparation reste un paragraphe", () => {
    const blocks = parseMarkdownBlocks("Le format a|b est ambigu ici.");
    expect(blocks.some((block) => block.kind === "table")).toBe(false);
    expect(blocks.some((block) => block.kind === "paragraph")).toBe(true);
  });

  it("les cellules supportent du gras inline (découpage préservé pour renderInline)", () => {
    const blocks = parseMarkdownBlocks(
      ["| Point | Détail |", "|---|---|", "| **Clé** | très important |"].join("\n"),
    );
    const table = blocks.find((block) => block.kind === "table");
    expect(table?.rows).toEqual([["**Clé**", "très important"]]);
  });

  it("un tableau suivi d'un paragraphe se termine proprement", () => {
    const blocks = parseMarkdownBlocks(
      ["| A | B |", "|---|---|", "| 1 | 2 |", "", "Texte après le tableau."].join("\n"),
    );
    const tableIndex = blocks.findIndex((block) => block.kind === "table");
    expect(tableIndex).toBeGreaterThanOrEqual(0);
    expect(blocks[tableIndex + 1]?.kind).toBe("paragraph");
    expect(blocks[tableIndex + 1]?.lines.join(" ")).toContain("Texte après le tableau.");
  });
});

describe("parseMarkdownBlocks — séparateurs et non-régressions", () => {
  it("une ligne --- devient un séparateur, pas un paragraphe", () => {
    const blocks = parseMarkdownBlocks("Section 1\n\n---\n\nSection 2");
    expect(blocks.filter((block) => block.kind === "hr")).toHaveLength(1);
    expect(blocks.filter((block) => block.kind === "paragraph")).toHaveLength(2);
  });

  it("*** et ___ sont aussi des séparateurs", () => {
    expect(parseMarkdownBlocks("***").some((b) => b.kind === "hr")).toBe(true);
    expect(parseMarkdownBlocks("___").some((b) => b.kind === "hr")).toBe(true);
  });

  it("un tiret simple reste du texte (pas un séparateur)", () => {
    const blocks = parseMarkdownBlocks("mot - mot");
    expect(blocks.some((b) => b.kind === "hr")).toBe(false);
  });

  it("le contenu d'un bloc de code n'est jamais interprété (tableau ou séparateur)", () => {
    const source = ["```md", "| A | B |", "|---|---|", "---", "```"].join("\n");
    const blocks = parseMarkdownBlocks(source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("code");
    expect(blocks[0].lines).toEqual(["| A | B |", "|---|---|", "---"]);
  });

  it("les blocs historiques restent reconnus (titres, listes, citations, code)", () => {
    const blocks = parseMarkdownBlocks(
      ["## Titre", "", "- puce un", "- puce deux", "", "> citation", "", "1. étape", "2. étape"].join("\n"),
    );
    const kinds = blocks.map((block) => block.kind);
    expect(kinds).toContain("heading");
    expect(kinds).toContain("ul");
    expect(kinds).toContain("ol");
    expect(kinds).toContain("quote");
  });
});
