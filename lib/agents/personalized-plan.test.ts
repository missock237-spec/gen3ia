import { describe, expect, it } from "vitest";

import { createPersonalizedPlan, policyForAgent, resolveAllowedTools, securityLevelForAgent } from "./personalized-plan";
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

  it("non-code → JAMAIS ui.components (exclusivité conservée)", () => {
    const allowed = resolveAllowedTools("standard", makeAgent({ type: "content" }));
    expect(allowed).not.toContain("ui.components");
    expect(allowed).toContain("web.search");
    expect(allowed).toContain("file.create");
  });

  it("code → ui.components présent (via '*' ou en liste explicite)", () => {
    // Sans exclusion : la sentinelle accorde tout le catalogue, ui.components inclus.
    const sentinel = resolveAllowedTools("power", makeAgent({ type: "code" }));
    expect(sentinel).toContain("*");
    // Avec une exclusion (webSearch:false) : la liste explicite d'un agent de
    // code contient littéralement ui.components.
    const explicit = resolveAllowedTools(
      "power",
      makeAgent({ type: "code", persona: personaWith({ webSearch: false }) }),
    );
    expect(explicit).toContain("ui.components");
    expect(explicit).toContain("code.execute");
    expect(explicit).not.toContain("web.search");
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

  it("caps.fileGeneration:false retire artifact.create", () => {
    const allowed = resolveAllowedTools(
      "standard",
      makeAgent({ persona: personaWith({ fileGeneration: false }) }),
    );
    expect(allowed).toContain("artifact.download");
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
  it("autorise code.execute et ui.components pour un agent de code (sentinelle '*')", () => {
    const policy = policyForAgent(makeAgent({ type: "code" }));
    expect(policy.allowedTools).toContain("*");
    expect(isToolAllowed(policy, "code.execute")).toBe(true);
    expect(isToolAllowed(policy, "ui.components")).toBe(true);
    expect(policy.allowCodeExecution).toBe(true);
  });

  it("n'autorise PAS ui.components pour un agent non-code, meme declare", () => {
    const policy = policyForAgent(
      makeAgent({ type: "content", tools: ["web.search", "ui.components"] }),
    );
    expect(policy.allowedTools).toContain("web.search");
    expect(policy.allowedTools).not.toContain("ui.components");
    expect(isToolAllowed(policy, "ui.components")).toBe(false);
  });

  it("donne le catalogue complet a un agent universel sans outil declare (whitelist)", () => {
    // Directive Task 107 : l'utilisateur ne désigne plus les outils — un agent
    // standard « nu » accède au registre complet (médias, emails, schedules…).
    const policy = policyForAgent(makeAgent({ type: "universal" }));
    for (const tool of ["video.create", "image.generate", "email.send", "schedule.create", "knowledge.search"]) {
      expect(policy.allowedTools).toContain(tool);
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
