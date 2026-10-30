import { describe, expect, it } from "vitest";

import { createPersonalizedPlan, policyForAgent, resolveAllowedTools, securityLevelForAgent } from "./personalized-plan";
import { GEN3IA_TOOLS } from "@/lib/tools/registry";
import { isToolAllowed } from "@/lib/security/execution-policy";
import type { AgentRecord } from "./schema";

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent_1",
    ownerId: "user_1",
    name: "Test Agent",
    description: "",
    type: "universal",
    systemPrompt: "Tu es un assistant de test.",
    modelStrategy: "automatic",
    autonomous: true,
    maxIterations: 8,
    tools: [],
    memoryEnabled: true,
    webResearchEnabled: true,
    documentGenerationEnabled: true,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const capsAllOn = { webSearch: true, codeExecution: true, dataAnalysis: true, fileGeneration: true };

/** Persona complète (le schéma exige tous les champs avec défauts côté type inféré). */
function personaWith(caps: Partial<typeof capsAllOn> = {}): AgentRecord["persona"] {
  return {
    tone: "professionnel",
    verbosity: "equilibre",
    humor: "aucun",
    language: "Français",
    constraints: [],
    capabilities: { ...capsAllOn, ...caps },
  };
}

describe("createPersonalizedPlan", () => {
  it("cree une chaine recherche -> llm quand la recherche web est activee", () => {
    const plan = createPersonalizedPlan(makeAgent(), "Analyse le marche des drones");
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].type).toBe("research");
    expect(plan.steps[1].type).toBe("llm");
    expect(plan.steps[1].dependencies).toEqual([plan.steps[0].id]);
    expect(plan.maxIterations).toBe(8);
    expect(plan.objective).toBe("Analyse le marche des drones");
  });

  it("cree un seul step llm sans recherche web", () => {
    const plan = createPersonalizedPlan(makeAgent({ webResearchEnabled: false }), "Ecris un haiku");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].type).toBe("llm");
    expect(plan.steps[0].dependencies).toEqual([]);
  });

  it("assigne le role correspondant au type d'agent", () => {
    const plan = createPersonalizedPlan(makeAgent({ type: "code", webResearchEnabled: false }), "Refactorise");
    expect(plan.steps[0].agentRole).toBe("developer");
  });

  it("plafonne les iterations a 20", () => {
    const plan = createPersonalizedPlan(makeAgent({ maxIterations: 50 }), "Objectif");
    expect(plan.maxIterations).toBeLessThanOrEqual(20);
  });
});

describe("securityLevelForAgent", () => {
  it("donne le niveau power aux agents de code", () => {
    expect(securityLevelForAgent(makeAgent({ type: "code" }))).toBe("power");
  });

  it("donne le niveau standard aux autres types", () => {
    for (const type of ["universal", "content", "research", "automation"] as const) {
      expect(securityLevelForAgent(makeAgent({ type }))).toBe("standard");
    }
  });
});

describe("resolveAllowedTools — modèle whitelist Task 107 (« * » sauf exclusion)", () => {
  it("standard sans exclusion → sentinelle '*' (catalogue complet)", () => {
    // Un agent de code (power) n'a AUCUNE exclusion par défaut : la sentinelle
    // s'applique telle quelle — les outils déclarés n'existent pas ici.
    expect(resolveAllowedTools("standard", makeAgent({ type: "code" }))).toEqual(["*"]);
  });

  it("standard + caps.webSearch:false → liste explicite complète SANS web.search", () => {
    const allowed = resolveAllowedTools(
      "standard",
      makeAgent({ persona: personaWith({ webSearch: false }) }),
    );
    // La sentinelle ne sait pas exprimer d'exception → liste explicite issue
    // du registre complet, qui contient toujours les autres outils.
    expect(allowed).not.toContain("*");
    expect(allowed).toContain("email.send");
    expect(allowed).toContain("image.generate");
    expect(allowed).toContain("video.create");
    expect(allowed).not.toContain("web.search");
  });

  it("non-code et code : le fantôme ui.components a DISPARU du catalogue (it.58)", () => {
    // it.58 : le connecteur 21st.dev n'a jamais existé — l'outil fantôme est
    // retiré du catalogue (aucun exécuteur), l'exclusivité est devenue sans
    // objet. Sans exclusion résiduelle, la sentinelle « * » reste compacte.
    const allowed = resolveAllowedTools("standard", makeAgent({ type: "content" }));
    expect(allowed).not.toContain("ui.components");
    const code = resolveAllowedTools("power", makeAgent({ type: "code" }));
    expect(code).not.toContain("ui.components");
  });

  it("caps.codeExecution:false retire TOUT le panel code (exécution, simulation, terminal)", () => {
    const allowed = resolveAllowedTools(
      "power",
      makeAgent({ type: "code", persona: personaWith({ codeExecution: false }) }),
    );
    expect(allowed).not.toContain("*");
    expect(allowed).not.toContain("code.execute");
    expect(allowed).not.toContain("code.simulate");
    expect(allowed).not.toContain("terminal.execute");
    expect(allowed).toContain("image.generate");
  });

  it("caps.fileGeneration:false retire artifact.create (it.58 : artifact.get est l'ID réel)", () => {
    const allowed = resolveAllowedTools(
      "standard",
      makeAgent({ persona: personaWith({ fileGeneration: false }) }),
    );
    // it.58 : le catalogue expose artifact.get (ID réel de l'exécuteur),
    // plus l'alias fantôme artifact.download.
    expect(allowed).toContain("artifact.get");
    expect(allowed).not.toContain("artifact.download");
    expect(allowed).not.toContain("artifact.create");
  });

  it("safe → liste réduite explicite SANS '*' (lecture seule par design)", () => {
    expect(resolveAllowedTools("safe", makeAgent({ tools: ["web.search", "web.open"] }))).toEqual([
      "web.search",
      "web.open",
    ]);
    // Aucun outil déclaré : whitelist vide — JAMAIS de sentinelle au niveau safe.
    expect(resolveAllowedTools("safe", makeAgent())).toEqual([]);
  });

  it("les outils déclarés hors registre ou exclus ne réintroduisent rien", () => {
    const allowed = resolveAllowedTools(
      "standard",
      makeAgent({ type: "content", tools: ["gmail", "ui.components", "bad tool!", "x".repeat(100), "email.send"] }),
    );
    expect(allowed).not.toContain("gmail");
    expect(allowed).not.toContain("bad tool!");
    expect(allowed).not.toContain("x".repeat(100));
    expect(allowed).not.toContain("ui.components");
    expect(allowed).toContain("email.send");
  });
});

describe("policyForAgent", () => {
  it("autorise code.execute pour un agent de code (sentinelle '*') — le fantôme ui.components n'existe plus (it.58)", () => {
    const policy = policyForAgent(makeAgent({ type: "code" }));
    expect(policy.allowedTools).toContain("*");
    expect(isToolAllowed(policy, "code.execute")).toBe(true);
    // it.58 : le fantôme a quitté le CATALOGUE — la barrière d'exécution
    // réelle est authorizeTool (TOOL_SECURITY + registre), pas la sentinelle.
    expect(GEN3IA_TOOLS.some((tool) => tool.name === "ui.components")).toBe(false);
    expect(policy.allowCodeExecution).toBe(true);
  });

  it("le fantôme ui.components déclaré par un agent ne revient jamais au catalogue (it.58)", () => {
    const policy = policyForAgent(
      makeAgent({ type: "content", tools: ["web.search", "ui.components"] }),
    );
    expect(policy.allowedTools).toContain("web.search");
    // Le nom déclaré peut traverser la résolution, mais il n'existe NI au
    // catalogue NI aux permissions — l'exécution échouera à authorizeTool.
    expect(GEN3IA_TOOLS.some((tool) => tool.name === "ui.components")).toBe(false);
  });

  it("donne le catalogue complet a un agent universel sans outil declare (whitelist)", () => {
    // Directive Task 107 : l'utilisateur ne désigne plus les outils — un agent
    // standard « nu » accède au registre complet (médias, emails, schedules…).
    const policy = policyForAgent(makeAgent({ type: "universal" }));
    // it.58 : sans exclusion résiduelle, la sentinelle reste compacte (« * ») —
    // la granularité fine passe par isToolAllowed (couche permissions).
    expect(policy.allowedTools).toContain("*");
    for (const tool of ["video.create", "image.generate", "email.send", "schedule.create", "knowledge.search", "workflow.run"]) {
      expect(isToolAllowed(policy, tool)).toBe(true);
    }
    expect(isToolAllowed(policy, "mcp.call")).toBe(true);
    // La barrière FINE reste la couche permissions du niveau standard.
    expect(policy.permissions).toContain("tool.external");
    expect(policy.permissions).toContain("network.write");
  });

  it("ajoute les outils declares a la whitelist du niveau", () => {
    const policy = policyForAgent(makeAgent({ type: "research", tools: ["web.open"] }));
    expect(policy.allowedTools).toContain("web.open");
  });

  it("rejette les noms d'outils suspects", () => {
    const policy = policyForAgent(makeAgent({ tools: ["bad tool!", "x".repeat(100)] }));
    expect(policy.allowedTools).not.toContain("bad tool!");
  });

  it("un agent safe reste limité à ses outils déclarés (aucune sentinelle)", () => {
    const policy = policyForAgent(makeAgent({ type: "teaching", tools: ["web.search"] }));
    expect(policy.allowedTools).toEqual(["web.search"]);
    expect(isToolAllowed(policy, "email.send")).toBe(false);
  });
});
