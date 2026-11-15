import { describe, expect, it } from "vitest";

import { evaluateCondition, resolveTemplate } from "./executor";
import { validateWorkflow } from "./validator";

describe("resolveTemplate — interpolation des sorties de nœuds", () => {
  it("remplace {{nodeId}} par la sortie texte du nœud", () => {
    expect(resolveTemplate("Résumé : {{step-1}}", { "step-1": "Analyse terminée" })).toBe("Résumé : Analyse terminée");
  });

  it("sérialise les sorties objet et remplace les sorties absentes par chaîne vide", () => {
    expect(resolveTemplate("{{objet}}|{{absent}}", { objet: { total: 42 } })).toBe('{"total":42}|');
  });
});

describe("evaluateCondition — routage conditionnel", () => {
  it("op existe : vrai si la sortie cible est non vide et non fausse", () => {
    expect(evaluateCondition({ target: "a", op: "existe" }, { a: "contenu" })).toBe(true);
    expect(evaluateCondition({ target: "a", op: "existe" }, { a: "" })).toBe(false);
    expect(evaluateCondition({ target: "a", op: "existe" }, { a: "false" })).toBe(false);
  });

  it("op eq/neq/contains : comparaisons insensibles à la casse pour contains", () => {
    expect(evaluateCondition({ target: "a", op: "eq", value: "OK" }, { a: "OK" })).toBe(true);
    expect(evaluateCondition({ target: "a", op: "neq", value: "KO" }, { a: "OK" })).toBe(true);
    expect(evaluateCondition({ target: "a", op: "contains", value: "prix" }, { a: "Le PRIX final est 10 €" })).toBe(true);
  });

  it("op gt/lt : comparaisons numériques", () => {
    expect(evaluateCondition({ target: "a", op: "gt", value: "10" }, { a: "12" })).toBe(true);
    expect(evaluateCondition({ target: "a", op: "lt", value: "10" }, { a: "12" })).toBe(false);
  });
});

describe("validateWorkflow — rejet d'un graphe avec cycle", () => {
  it("signale un graphe invalide quand un cycle existe", () => {
    const result = validateWorkflow({
      id: "wf",
      name: "Cycle",
      version: 1,
      nodes: [
        { id: "a", type: "agent", name: "A", config: {}, position: { x: 0, y: 0 }, enabled: true },
        { id: "b", type: "agent", name: "B", config: {}, position: { x: 1, y: 0 }, enabled: true },
      ],
      edges: [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "a" },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/cycl/i);
  });
});
