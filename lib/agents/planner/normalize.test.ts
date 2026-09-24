import { describe, expect, it } from "vitest";

import { normalizePlanSteps } from "./normalize";
import { AgentRecordSchema } from "../schema";

describe("normalizePlanSteps — étapes de délégation (sous-agents)", () => {
  it("préserve une étape 'agent' valide avec son agentId", () => {
    const steps = normalizePlanSteps([
      { id: "s1", type: "subagent", agentId: "agent-123", name: "Analyse juridique", description: "Analyser le contrat", dependencies: [] },
    ]);
    expect(steps[0]).toMatchObject({ type: "agent", agentId: "agent-123" });
  });

  it("dégrade en 'llm' une étape 'agent' sans agentId", () => {
    const steps = normalizePlanSteps([
      { id: "s1", type: "agent", name: "Délégation floue", description: "Faire appel à un expert", dependencies: [] },
    ]);
    expect(steps[0]).toMatchObject({ type: "llm" });
    expect((steps[0] as { agentId?: string }).agentId).toBeUndefined();
  });

  it("accepte les alias 'delegate' et 'delegation'", () => {
    const steps = normalizePlanSteps([
      { id: "a", type: "delegate", agentId: "x1", name: "A", description: "A" },
      { id: "b", type: "delegation", agentId: "x2", name: "B", description: "B" },
    ]);
    expect(steps.map((step) => (step as { type: string }).type)).toEqual(["agent", "agent"]);
  });
});

describe("AgentRecordSchema — réglages du Builder (rétrocompatible)", () => {
  it("applique les valeurs par défaut sur un enregistrement legacy (sans les nouveaux champs)", () => {
    const parsed = AgentRecordSchema.parse({ name: "Agent Legacy", description: "Agent créé avant les réglages avancés" });
    expect(parsed.temperature).toBe(0.7);
    expect(parsed.authorizationMode).toBe("always_ask");
    expect(parsed.subAgentIds).toEqual([]);
    expect(parsed.mcpEnabled).toBe(true);
    expect(parsed.budgetEurMinor).toBeUndefined();
  });

  it("valide les bornes de température et du budget", () => {
    expect(() => AgentRecordSchema.parse({ name: "Aa", description: "temperature hors bornes", temperature: 3 })).toThrow();
    expect(() => AgentRecordSchema.parse({ name: "Aa", description: "budget négatif", budgetEurMinor: -1 })).toThrow();
    expect(() => AgentRecordSchema.parse({ name: "Aa", description: "trop de sous-agents", subAgentIds: ["1", "2", "3", "4", "5", "6"] })).toThrow();
  });

  it("accepte un budget à 0 (pas de plafond) et une température calibrée", () => {
    const parsed = AgentRecordSchema.parse({ name: "Aa", description: "réglages valides", temperature: 0.2, budgetEurMinor: 0 });
    expect(parsed.temperature).toBe(0.2);
    expect(parsed.budgetEurMinor).toBe(0);
  });
});
