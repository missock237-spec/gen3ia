import { describe, expect, it } from "vitest";

import {
  buildKnowledgeContext,
  KNOWLEDGE_CONTEXT_MAX_RESULTS,
  KNOWLEDGE_MIN_SCORE,
  selectKnowledgeResults,
  shouldSearchKnowledge,
} from "./chat-context";
import type { KnowledgeSearchResult } from "./search";

/**
 * Étape 15 du plan 20 — Knowledge injecté automatiquement dans la
 * conversation du projet. Contrats verrouillés :
 *  1. recherche uniquement avec un projet (knowledge scopée par projet) ;
 *  2. les fragments bruités (score faible) sont écartés ;
 *  3. plafond de fragments et d'aperçu ;
 *  4. bloc vide si rien de pertinent — jamais de contexte inutile.
 */

function result(overrides: Partial<KnowledgeSearchResult>): KnowledgeSearchResult {
  return { id: "f1", documentId: "doc1", text: "Texte du fragment.", chunkIndex: 0, score: 0.8, ...overrides };
}

describe("shouldSearchKnowledge", () => {
  it("exige un projet et un message exploitable", () => {
    expect(shouldSearchKnowledge({ projectId: "p1", message: "Que dit notre charte sur les congés ?" })).toBe(true);
    expect(shouldSearchKnowledge({ projectId: undefined, message: "Une question sans projet" })).toBe(false);
    expect(shouldSearchKnowledge({ projectId: "p1", message: "court" })).toBe(false);
  });
});

describe("selectKnowledgeResults", () => {
  it("écarte les scores faibles, trie par pertinence et plafonne", () => {
    const results = [
      result({ id: "low", score: 0.1 }),
      result({ id: "mid", score: 0.5, documentId: "doc2" }),
      result({ id: "high", score: 0.9, documentId: "doc3" }),
    ];
    const selected = selectKnowledgeResults(results);
    expect(selected.map((r) => r.id)).toEqual(["high", "mid"]);
    expect(selected.every((r) => r.score >= KNOWLEDGE_MIN_SCORE)).toBe(true);
    expect(selected).toHaveLength(Math.min(2, KNOWLEDGE_CONTEXT_MAX_RESULTS));
  });
});

describe("buildKnowledgeContext", () => {
  it("formate les fragments citables avec document, fragment et score", () => {
    const context = buildKnowledgeContext([
      result({ text: "La charte prévoit 25 jours de congés annuels.", score: 0.87 }),
    ]);
    expect(context).toContain("doc1");
    expect(context).toContain("0.87");
    expect(context).toContain("25 jours de congés annuels");
  });

  it("retourne une chaîne vide sans résultat pertinent (jamais de bruit)", () => {
    expect(buildKnowledgeContext([])).toBe("");
    expect(buildKnowledgeContext([result({ score: 0.05 })])).toBe("");
  });
});
