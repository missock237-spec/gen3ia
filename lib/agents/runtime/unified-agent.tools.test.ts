import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 107-c — SENTINELLE "*" + AUTO-SÉLECTION DES OUTILS dans le planner
 * universel (contrat inter-lots du worklog 107-0) :
 *  1. allowedTools contenant "*" → catalogue COMPLET injecté dans le prompt
 *     (availableCapabilities) ET aucun filtrage des steps toolName ;
 *  2. allowedTools absent → comportement historique (catalogue complet,
 *     pas de filtrage) ;
 *  3. allowedTools liste explicite sans "*" → comportement historique
 *     PRÉSERVÉ (catalogue filtré + step hors périmètre dégradé en llm) ;
 *  4. le prompt system contient la règle « SÉLECTION DES OUTILS » et la
 *     section d'indices d'intention déterministes (tool-intent).
 * Le filtrage fin de sécurité reste en aval (authorizeTool + permissions +
 * HITL du secure-tool-executor) : non testé ici, hors périmètre.
 */

vi.mock("@/lib/ai/router", () => ({ generate: vi.fn() }));
vi.mock("@/lib/integrations/custom-apis/repository", () => ({ listEnabledCustomApis: vi.fn(async () => []) }));
vi.mock("@/lib/skills/runtime-bridge", () => ({
  selectSkillsForObjective: vi.fn(async () => null),
  formatSkillsSection: vi.fn(() => ""),
}));
vi.mock("@/lib/agents/evolution", () => ({ getEvolutionBrief: vi.fn(async () => ({ text: "" })) }));

import { generate } from "@/lib/ai/router";
import { planUniversalAgent } from "./unified-agent";

const mockGenerate = vi.mocked(generate);

/** Réponse planner JSON valide avec un step tool video.create. */
function plannerResponseWithVideoStep(): { text: string } {
  return {
    text: JSON.stringify({
      executionId: "exec-tools-1",
      objective: "objectif",
      steps: [
        {
          id: "step-video",
          type: "tool",
          name: "Production vidéo",
          description: "Lancer la production vidéo demandée.",
          toolName: "video.create",
          input: { prompt: "une vidéo sur le café" },
          dependencies: [],
        },
      ],
      maxConcurrency: 1,
      maxIterations: 1,
    }),
  };
}

type GenerateCall = { messages: Array<{ role: string; content: string }> };

function lastCallPrompts(): { systemPrompt: string; userPrompt: string } {
  const call = (mockGenerate.mock.calls.at(-1)?.[0] ?? { messages: [] }) as GenerateCall;
  const systemPrompt = call.messages.find((m) => m.role === "system")?.content ?? "";
  const userPrompt = call.messages.find((m) => m.role === "user")?.content ?? "";
  return { systemPrompt, userPrompt };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planUniversalAgent — sentinelle allowedTools (contrat 107)", () => {
  it("allowedTools ['*'] → catalogue COMPLET dans availableCapabilities + step video.create CONSERVÉ", async () => {
    mockGenerate.mockResolvedValue(plannerResponseWithVideoStep() as never);
    const plan = await planUniversalAgent("user-1", "crée-moi une vidéo TikTok de 30 secondes sur le café", {
      agent: { allowedTools: ["*"] },
    });

    const { userPrompt } = lastCallPrompts();
    expect(userPrompt).toContain("availableCapabilities");
    // Catalogue complet : au moins deux outils "extrêmes" du registre présent.
    expect(userPrompt).toContain("video.create");
    expect(userPrompt).toContain("email.send");

    // Aucun filtrage déclaratif : le step tool du LLM reste intact.
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].type).toBe("tool");
    expect(plan.steps[0].toolName).toBe("video.create");
  });

  it("allowedTools absent → catalogue complet + pas de filtrage (comportement historique)", async () => {
    mockGenerate.mockResolvedValue(plannerResponseWithVideoStep() as never);
    const plan = await planUniversalAgent("user-1", "crée-moi une vidéo sur le café");

    const { userPrompt } = lastCallPrompts();
    expect(userPrompt).toContain("video.create");
    expect(userPrompt).toContain("email.send");
    expect(plan.steps[0].toolName).toBe("video.create");
    expect(plan.steps[0].type).toBe("tool");
  });

  it("allowedTools ['web.search'] explicite → catalogue FILTRÉ + step video.create dégradé (comportement préservé)", async () => {
    mockGenerate.mockResolvedValue(plannerResponseWithVideoStep() as never);
    const plan = await planUniversalAgent("user-1", "crée-moi une vidéo sur le café", {
      agent: { allowedTools: ["web.search"] },
    });

    const { userPrompt, systemPrompt } = lastCallPrompts();
    // Catalogue filtré : web.search présent, video.create ABSENT du prompt.
    expect(userPrompt).toContain("web.search");
    expect(userPrompt).not.toContain("video.create");
    // La section d'indices n'oriente PAS vers un outil hors catalogue.
    expect(systemPrompt).not.toContain('toolName="video.create"');

    // Filtrage des steps conservé : dégradation résiliente en llm.
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].type).toBe("llm");
    expect(plan.steps[0].toolName).toBeUndefined();
    expect(plan.steps[0].description).toContain("hors périmètre");
  });
});

describe("planUniversalAgent — guidance d'auto-sélection (contrat 107)", () => {
  it("le prompt system porte la règle générale « l'utilisateur ne choisit jamais un outil »", async () => {
    mockGenerate.mockResolvedValue(plannerResponseWithVideoStep() as never);
    await planUniversalAgent("user-1", "crée-moi une vidéo sur le café", { agent: { allowedTools: ["*"] } });

    const { systemPrompt } = lastCallPrompts();
    expect(systemPrompt).toContain("SÉLECTION DES OUTILS");
    expect(systemPrompt).toContain("il ne choisit jamais un outil");
    expect(systemPrompt).toContain("les outils externes risqués passent de toute façon par la validation humaine");
  });

  it("les indices d'intention déterministes sont injectés avec l'outil du catalogue EFFECTIF", async () => {
    mockGenerate.mockResolvedValue(plannerResponseWithVideoStep() as never);
    await planUniversalAgent("user-1", "crée-moi une vidéo TikTok de 30 secondes sur le café", {
      agent: { allowedTools: ["*"] },
    });

    const { systemPrompt } = lastCallPrompts();
    expect(systemPrompt).toContain("SÉLECTION AUTOMATIQUE DES OUTILS");
    expect(systemPrompt).toContain('toolName="video.create"');
    expect(systemPrompt).toContain("Ne force un outil QUE si la demande l'appelle réellement");
  });

  it("les indices respectent le catalogue filtré (outil indisponible = aucune consigne d'outil)", async () => {
    mockGenerate.mockResolvedValue(plannerResponseWithVideoStep() as never);
    await planUniversalAgent("user-1", "crée-moi une vidéo TikTok", {
      agent: { allowedTools: ["web.search"] },
    });

    const { systemPrompt } = lastCallPrompts();
    expect(systemPrompt).toContain("SÉLECTION AUTOMATIQUE DES OUTILS");
    expect(systemPrompt).toContain("INDISPONIBLE");
    expect(systemPrompt).not.toContain('toolName="video.create"');
  });

  it("aucun indice d'intention → aucune section injectée (pas de bruit)", async () => {
    mockGenerate.mockResolvedValue(plannerResponseWithVideoStep() as never);
    await planUniversalAgent("user-1", "Bonjour", { agent: { allowedTools: ["*"] } });

    const { systemPrompt } = lastCallPrompts();
    expect(systemPrompt).not.toContain("SÉLECTION AUTOMATIQUE DES OUTILS");
  });
});
