import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PIPELINE INTENT → INFRASTRUCTURE (concept #4) : classification LLM bornée
 * (JSON, échec explicite), provisionnement RÉEL via les dépôts existants
 * (agent Studio par quick-create, graphe de workflow validé, tâche
 * planifiée, projet), dry-run sans exécution, `unknown` = réponse honnête
 * (jamais de ressource aléatoire).
 */

const generateMock = vi.fn();
vi.mock("@/lib/ai/router", () => ({
  generate: (...args: unknown[]) => generateMock(...args),
}));

const createAgentRecordMock = vi.fn();
vi.mock("@/lib/agents/repository", () => ({
  createAgentRecord: (...args: unknown[]) => createAgentRecordMock(...args),
}));

const docSet = vi.fn();
vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ set: docSet })),
    })),
  },
}));

const createDeveloperProjectMock = vi.fn();
vi.mock("@/lib/developer/projects", () => ({
  createDeveloperProject: (...args: unknown[]) => createDeveloperProjectMock(...args),
}));

const scheduleCreateToolMock = vi.fn();
vi.mock("@/lib/tools/schedules", () => ({
  scheduleCreateTool: {
    execute: (...args: unknown[]) => scheduleCreateToolMock(...args),
  },
}));

import { classifyIntent, provisionFromIntent } from "./intent";

beforeEach(() => {
  generateMock.mockReset();
  createAgentRecordMock.mockReset();
  docSet.mockReset();
  createDeveloperProjectMock.mockReset();
  scheduleCreateToolMock.mockReset();
  docSet.mockResolvedValue(undefined);
});

describe("classification", () => {
  it("JSON brut et balisé acceptés ; sortie non structurée → erreur explicite", async () => {
    generateMock.mockResolvedValueOnce({ text: "```json\n" + JSON.stringify({ kind: "agent", reasoning: "r", params: { name: "Compta", typeKey: "custom", customType: "Comptabilité" } }) + "\n```" });
    const result = await classifyIntent("Crée-moi un agent comptable");
    expect(result.kind).toBe("agent");
    expect(result.params.name).toBe("Compta");
    generateMock.mockResolvedValueOnce({ text: "Je ne sais pas quoi répondre." });
    await expect(classifyIntent("blabla")).rejects.toThrow("non structurée");
  });
});

describe("provisionnement", () => {
  it("AGENT : quick-create réel + orgId relayé, réponse = ressource créée", async () => {
    generateMock.mockResolvedValue({ text: JSON.stringify({ kind: "agent", reasoning: "r", params: { name: "Compta", typeKey: "custom", customType: "Comptabilité" } }) });
    createAgentRecordMock.mockResolvedValue({ id: "agent-1", name: "Compta", typeLabel: "Comptabilité" });
    const result = await provisionFromIntent({
      userId: "u1",
      orgId: "org-1",
      objective: "Crée-moi un agent comptable",
    });
    expect(result.executed).toBe(true);
    expect(result.resource?.id).toBe("agent-1");
    expect(result.resource?.detail).toContain("Comptabilité");
    const [ownerId, input, opts] = createAgentRecordMock.mock.calls[0];
    expect(ownerId).toBe("u1");
    expect(input.type).toBeTruthy(); // payload complet déduit
    expect(opts).toEqual({ orgId: "org-1" });
  });

  it("WORKFLOW : graphe linéaire agent→sortie validé puis persisté", async () => {
    generateMock.mockResolvedValue({
      text: JSON.stringify({
        kind: "workflow",
        reasoning: "r",
        params: { name: "Veille concurrentielle", steps: [
          { name: "Collecte", description: "Rechercher les actualités concurrents" },
          { name: "Synthèse", description: "Synthétiser les tendances hebdo" },
        ] },
      }),
    });
    const result = await provisionFromIntent({ userId: "u1", objective: "Automatise une veille concurrentielle hebdomadaire" });
    expect(result.executed).toBe(true);
    expect(result.resource?.kind).toBe("workflow");
    const persisted = docSet.mock.calls[0][0];
    expect(persisted.name).toBe("Veille concurrentielle");
    expect(persisted.nodes).toHaveLength(3); // 2 agents + 1 output
    expect(persisted.edges).toHaveLength(2);
    expect(persisted.userId).toBe("u1");
  });

  it("SCHEDULE : outil réel appelé avec les paramètres classifiés", async () => {
    scheduleCreateToolMock.mockResolvedValue({ created: true, schedule: { id: "sched-1" } });
    generateMock.mockResolvedValue({
      text: JSON.stringify({
        kind: "schedule",
        reasoning: "r",
        params: { objective: "Rapport des ventes chaque matin", name: "Rapport ventes", daysOfWeek: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "09:00" },
      }),
    });
    const result = await provisionFromIntent({ userId: "u1", objective: "Tous les matins, un rapport des ventes" });
    expect(result.executed).toBe(true);
    expect(result.resource?.id).toBe("sched-1");
    const [input, context] = scheduleCreateToolMock.mock.calls[0];
    expect(input.objective).toContain("Rapport des ventes");
    expect(input.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(context.userId).toBe("u1");
  });

  it("PROJECT : projet réel créé", async () => {
    createDeveloperProjectMock.mockResolvedValue({ id: "proj-1", name: "Refonte site", framework: "nextjs" });
    generateMock.mockResolvedValue({ text: JSON.stringify({ kind: "project", reasoning: "r", params: { name: "Refonte site", framework: "nextjs" } }) });
    const result = await provisionFromIntent({ userId: "u1", objective: "Lance un projet de refonte du site" });
    expect(result.resource?.kind).toBe("project");
    expect(createDeveloperProjectMock).toHaveBeenCalledWith("u1", expect.objectContaining({ name: "Refonte site" }));
  });

  it("dryRun : proposition retournée, AUCUN provision", async () => {
    generateMock.mockResolvedValue({ text: JSON.stringify({ kind: "agent", reasoning: "r", params: { name: "X", typeKey: "custom", customType: "Y" } }) });
    const result = await provisionFromIntent({ userId: "u1", objective: "Crée un agent Y", dryRun: true });
    expect(result.executed).toBe(false);
    expect(result.plan.action).toBeTruthy();
    expect(createAgentRecordMock).not.toHaveBeenCalled();
  });

  it("kind unknown : réponse honnête sans ressource (jamais de création aléatoire)", async () => {
    generateMock.mockResolvedValue({ text: JSON.stringify({ kind: "unknown", reasoning: "hors périmètre", params: {} }) });
    const result = await provisionFromIntent({ userId: "u1", objective: "Fais-moi un café", dryRun: false });
    expect(result.executed).toBe(false);
    expect(result.plan.kind).toBe("unknown");
    expect(result.resource).toBeUndefined();
  });

  it("workflow sous-défini (une seule étape) → erreur explicite, rien persisté", async () => {
    generateMock.mockResolvedValue({ text: JSON.stringify({ kind: "workflow", reasoning: "r", params: { name: "X", steps: [{ name: "solo", description: "d" }] } }) });
    await expect(provisionFromIntent({ userId: "u1", objective: "Automatise X" })).rejects.toThrow("au moins deux étapes");
    expect(docSet).not.toHaveBeenCalled();
  });
});
