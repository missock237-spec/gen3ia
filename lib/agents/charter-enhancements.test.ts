import { describe, expect, it } from "vitest";

import { buildAgentCharter, WIZARD_AGENT_TYPES, wizardTypeForKey } from "./charter";
import { historyContextNote } from "./chat-engine";

describe("charter — anti-hallucination renforcée", () => {
  const agent = {
    name: "Commercial Test",
    description: "Agent commercial de test.",
    type: "universal",
    typeLabel: "Commercial",
    skills: ["Prospection"],
  };

  it("la charte interdit explicitement d'inventer des faits et résultats", () => {
    const charter = buildAgentCharter(agent);
    expect(charter).toContain("INTERDICTION ABSOLUE D'HALLUCINER");
    expect(charter).toContain("outil RÉELLEMENT exécuté");
    expect(charter).toContain("COMPRÉHENSION OBLIGATOIRE");
  });

  it("la charte impose l'analyse des messages précédents", () => {
    const charter = buildAgentCharter(agent);
    expect(charter).toContain("TOUS les messages précédents");
  });

  it("les nouveaux types demandés existent dans le catalogue", () => {
    expect(wizardTypeForKey("teaching")?.label).toBe("Enseignement");
    expect(wizardTypeForKey("sales")?.label).toBe("Commercial");
    expect(wizardTypeForKey("voice")?.label).toBe("Agent vocal");
    expect(WIZARD_AGENT_TYPES.length).toBeGreaterThanOrEqual(10);
  });
});

describe("historyContextNote", () => {
  it("renvoie undefined sans historique", () => {
    expect(historyContextNote([])).toBeUndefined();
  });

  it("construit une note lisible avec les derniers échanges", () => {
    const note = historyContextNote([
      { role: "user", content: "Parle de mon produit A" },
      { role: "assistant", content: "Le produit A coûte 15 euros." },
      { role: "user", content: "Crée une affiche pour lui" },
    ]);
    expect(note).toContain("Contexte de la conversation");
    expect(note).toContain("Utilisateur : Parle de mon produit A");
    expect(note).toContain("Assistant : Le produit A coûte 15 euros.");
  });

  it("limite le nombre d'échanges et la longueur des lignes", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      role: "user" as const,
      content: `Message très long numéro ${index} — ${"détail ".repeat(200)}`,
    }));
    const note = historyContextNote(many, 4);
    expect(note).not.toContain("numéro 3 —");
    expect(note?.split("\n").length).toBeLessThanOrEqual(5);
    for (const line of note?.split("\n") ?? []) {
      expect(line.length).toBeLessThanOrEqual(560);
    }
  });
});
