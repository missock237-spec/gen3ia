import { describe, expect, it } from "vitest";

import {
  CLARIFICATION_MARKER,
  detectAmbiguitySignals,
  deterministicClarifyingQuestion,
  isClarificationPending,
  markClarification,
  resolveClarifiedObjective,
  stripClarificationMark,
} from "./clarification-followup";

describe("Task 135 — clarification d'intention : marqueur et suivi contextuel", () => {
  it("markClarification pose le marqueur une seule fois (idempotent)", () => {
    const once = markClarification("Quelle durée visez-vous ?");
    expect(once.startsWith(CLARIFICATION_MARKER)).toBe(true);
    expect(markClarification(once)).toBe(once);
  });

  it("stripClarificationMark retire le marqueur", () => {
    const marked = markClarification("Quelle durée visez-vous ?");
    expect(stripClarificationMark(marked)).toBe("Quelle durée visez-vous ?");
    expect(isClarificationPending(marked)).toBe(true);
    expect(isClarificationPending("Réponse ordinaire.")).toBe(false);
  });

  it("resolveClarifiedObjective rattache la réponse à la demande d'origine", () => {
    const history = [
      { role: "user" as const, content: "Prépare le lancement de mon produit" },
      { role: "assistant" as const, content: markClarification("Souhaitez-vous un plan de lancement ou l'envoi de la campagne ?") },
    ];
    const resolved = resolveClarifiedObjective("Un plan de lancement détaillé", history);
    expect(resolved).not.toBeNull();
    expect(resolved?.originalRequest).toContain("lancement de mon produit");
    expect(resolved?.objective).toContain("Un plan de lancement détaillé");
    expect(resolved?.refused).toBe(false);
  });

  it("resolveClarifiedObjective ignore un refus explicite", () => {
    const history = [
      { role: "user" as const, content: "Prépare le lancement" },
      { role: "assistant" as const, content: markClarification("Quel type de livrable ?") },
    ];
    expect(resolveClarifiedObjective("annule", history)).toBeNull();
    expect(resolveClarifiedObjective("non merci", history)).toBeNull();
  });

  it("resolveClarifiedObjective ne se déclenche pas sans question en attente", () => {
    const history = [
      { role: "user" as const, content: "Crée une vidéo TikTok" },
      { role: "assistant" as const, content: "Votre production vidéo est lancée." },
    ];
    expect(resolveClarifiedObjective("et un plan aussi", history)).toBeNull();
  });

  it("resolveClarifiedObjective casse le motif si une réponse a déjà été livrée", () => {
    const history = [
      { role: "user" as const, content: "Prépare le lancement" },
      { role: "assistant" as const, content: markClarification("Quel livrable ?") },
      { role: "user" as const, content: "un plan" },
      { role: "assistant" as const, content: "Voici le plan demandé…" },
    ];
    expect(resolveClarifiedObjective("autre chose", history)).toBeNull();
  });

  it("resolveClarifiedObjective ignore les tours système", () => {
    const history = [
      { role: "user" as const, content: "Fais le montage" },
      { role: "system" as const, content: "contexte interne" },
      { role: "assistant" as const, content: markClarification("Quel montage exactement ?") },
    ];
    const resolved = resolveClarifiedObjective("le montage de mes vacances", history);
    expect(resolved?.originalRequest).toBe("Fais le montage");
  });
});

describe("Task 135 — garde déterministe d'ambiguïté", () => {
  it("détecte les référents implicites non résolvables", () => {
    expect(detectAmbiguitySignals("fais-le")).toEqual({ ambiguous: true, reason: "implicit-referent" });
    expect(detectAmbiguitySignals("refais-moi ça")).toEqual({ ambiguous: true, reason: "implicit-referent" });
    expect(detectAmbiguitySignals("la même chose")).toEqual({ ambiguous: true, reason: "implicit-referent" });
    expect(detectAmbiguitySignals("continue")).toEqual({ ambiguous: true, reason: "implicit-referent" });
  });

  it("détecte les demandes d'action trop courtes", () => {
    expect(detectAmbiguitySignals("crée")).toEqual({ ambiguous: true, reason: "too-short" });
    expect(detectAmbiguitySignals("génère")).toEqual({ ambiguous: true, reason: "too-short" });
  });

  it("n'alerte pas sur une demande claire et complète", () => {
    expect(detectAmbiguitySignals("Crée une vidéo TikTok de 30 secondes avec sous-titres karaoké")).toEqual({ ambiguous: false, reason: "" });
    expect(detectAmbiguitySignals("Bonjour, comment vas-tu ?")).toEqual({ ambiguous: false, reason: "" });
  });

  it("deterministicClarifyingQuestion produit une question actionnable", () => {
    const signals = detectAmbiguitySignals("fais-le");
    const question = deterministicClarifyingQuestion(signals, "fais-le");
    expect(question).toContain("référence");
    const none = deterministicClarifyingQuestion({ ambiguous: false, reason: "" }, "demande claire");
    expect(none).toBeNull();
  });
});
