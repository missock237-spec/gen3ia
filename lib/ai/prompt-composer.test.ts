import { describe, expect, it } from "vitest";

import { composeStructuredPrompt, REASONING_DIRECTIVE } from "./prompt-composer";

describe("REASONING_DIRECTIVE — raisonnement par étapes (Chain-of-Thought)", () => {
  it("exige la décomposition de la logique AVANT la conclusion", () => {
    expect(REASONING_DIRECTIVE).toMatch(/D[ée]COMPOSE/i);
    expect(REASONING_DIRECTIVE).toMatch(/hypoth[èe]ses/i);
    expect(REASONING_DIRECTIVE).toMatch(/avant/i);
  });

  it("garde le raisonnement INTERNE (jamais de brouillon visible)", () => {
    expect(REASONING_DIRECTIVE).toMatch(/INTERNE|interne/);
    expect(REASONING_DIRECTIVE).toMatch(/JAMAIS appara[îi]tre dans la r[ée]ponse/i);
  });

  it("couvre les étapes de la méthode : type, décomposition, hypothèses, vérification, formulation", () => {
    expect(REASONING_DIRECTIVE).toMatch(/IDENTIFIE/);
    expect(REASONING_DIRECTIVE).toMatch(/D[ÉEé]COMPOSE/);
    expect(REASONING_DIRECTIVE).toMatch(/LISTE tes hypoth[èe]ses/);
    expect(REASONING_DIRECTIVE).toMatch(/v[ée]rifie la coh[ée]rence/);
    expect(REASONING_DIRECTIVE).toMatch(/FORMULE ensuite ta r[ée]ponse/);
  });
});

describe("composeStructuredPrompt — squelette normalisé", () => {
  it("assemble toutes les sections dans l'ordre imposé", () => {
    const composed = composeStructuredPrompt({
      role: "Tu es CodeMaster, agent développeur.",
      context: "Utilisateur : Jean.",
      constraints: ["Ne jamais inventer de source.", "- Déjà préfixé par un tiret."],
      outputFormat: "Réponds en markdown.",
      examples: "EXEMPLE : question → réponse structurée.",
    });
    const roleIndex = composed.indexOf("RÔLE");
    const contextIndex = composed.indexOf("CONTEXTE");
    const methodIndex = composed.indexOf("MÉTHODE DE RAISONNEMENT");
    const constraintsIndex = composed.indexOf("CONTRAINTES STRICTES");
    const formatIndex = composed.indexOf("FORMAT DE SORTIE");
    const examplesIndex = composed.indexOf("EXEMPLES DE QUALITÉ ATTENDUE");
    expect(roleIndex).toBeGreaterThanOrEqual(0);
    expect(contextIndex).toBeGreaterThan(roleIndex);
    expect(methodIndex).toBeGreaterThan(contextIndex);
    expect(constraintsIndex).toBeGreaterThan(methodIndex);
    expect(formatIndex).toBeGreaterThan(constraintsIndex);
    expect(examplesIndex).toBeGreaterThan(formatIndex);
    expect(composed).toContain("Tu es CodeMaster, agent développeur.");
    expect(composed).toContain("Utilisateur : Jean.");
    expect(composed).toContain("- Ne jamais inventer de source.");
    expect(composed).toContain("- Déjà préfixé par un tiret.");
    expect(composed).toContain("Réponds en markdown.");
  });

  it("injecte la directive CoT par défaut dans la section MÉTHODE", () => {
    const composed = composeStructuredPrompt({ role: "Agent." });
    expect(composed).toContain(REASONING_DIRECTIVE);
  });

  it("method: false supprime EXPLICITEMENT la directive CoT (tâches sans raisonnement)", () => {
    const composed = composeStructuredPrompt({ role: "Classificateur.", method: false, outputFormat: "JSON strict." });
    expect(composed).not.toContain("MÉTHODE DE RAISONNEMENT");
    expect(composed).not.toContain(REASONING_DIRECTIVE);
    expect(composed).toContain("JSON strict.");
  });

  it("les sections absentes ou vides disparaissent (aucun squelette fantôme)", () => {
    const composed = composeStructuredPrompt({ role: "Agent.", constraints: ["", "   "], context: "", examples: undefined });
    expect(composed).not.toContain("CONTEXTE");
    expect(composed).not.toContain("CONTRAINTES STRICTES");
    expect(composed).not.toContain("EXEMPLES DE QUALITÉ ATTENDUE");
    // Les sections présentes restent.
    expect(composed).toContain("RÔLE");
    expect(composed).toContain("MÉTHODE DE RAISONNEMENT");
  });

  it("le rôle seul produit un prompt minimal exploitable", () => {
    const composed = composeStructuredPrompt({ role: "Agent minimal." });
    expect(composed).toContain("Agent minimal.");
    expect(composed).toContain(REASONING_DIRECTIVE);
  });
});
