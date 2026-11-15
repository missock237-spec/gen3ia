import { describe, expect, it } from "vitest";

import { formatRecallNote, shouldSummarize } from "./episodic";

const baseMemory = {
  type: "conversation" as const,
  content: "On a décidé d'utiliser Next.js et Tailwind pour le projet X.",
  createdAt: "2026-01-15T10:00:00.000Z",
};

describe("formatRecallNote", () => {
  it("retourne undefined sans souvenir pertinent", () => {
    expect(formatRecallNote([])).toBeUndefined();
    expect(formatRecallNote([{ memory: baseMemory, score: 0.1 }])).toBeUndefined();
    expect(formatRecallNote([{ memory: { ...baseMemory, content: "   " }, score: 0.9 }])).toBeUndefined();
  });

  it("formate les souvenirs pertinents en note de contexte", () => {
    const note = formatRecallNote([
      { memory: baseMemory, score: 0.82 },
      { memory: { ...baseMemory, type: "decision" as const }, score: 0.61 },
    ]);
    expect(note).toContain("mémoire épisodique");
    expect(note).toContain("[échange passé (2026-01-15)]");
    expect(note).toContain("[décision (2026-01-15)]");
    expect(note).toContain("Next.js et Tailwind");
  });

  it("limite le nombre de souvenirs et filtre par score", () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      memory: { ...baseMemory, content: `Souvenir numéro ${index}` },
      score: 0.9,
    }));
    const note = formatRecallNote(many);
    expect(note).toContain("Souvenir numéro 0");
    expect(note).not.toContain("Souvenir numéro 3");
  });
});

describe("shouldSummarize", () => {
  it("ne résume pas les conversations courtes", () => {
    expect(shouldSummarize(0)).toBe(false);
    expect(shouldSummarize(6)).toBe(false);
  });

  it("résume à intervalle régulier à partir de 8 messages", () => {
    expect(shouldSummarize(8)).toBe(true);
    expect(shouldSummarize(9)).toBe(false);
    expect(shouldSummarize(16)).toBe(true);
    expect(shouldSummarize(24)).toBe(true);
  });
});
