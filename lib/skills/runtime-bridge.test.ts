import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PONT SKILLS → RUNTIME : sélection bornée et cloisonnée (system + privées
 * de l'utilisateur), composition réelle via composeSkills, fail-soft total
 * (panne → null), section prompt déterministe.
 */

const listSkillsMock = vi.fn();
vi.mock("./repository", () => ({
  listSkills: (...args: unknown[]) => listSkillsMock(...args),
}));

vi.mock("./composer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./composer")>()),
}));

import { formatSkillsSection, selectSkillsForObjective } from "./runtime-bridge";

function skill(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    name: "Rédaction SEO",
    description: "Rédiger des articles optimisés pour les moteurs de recherche",
    category: "marketing",
    capabilities: [{ name: "rédaction", description: "contenu long" }],
    inputs: [],
    outputs: [],
    triggers: [],
    requiredTools: ["web.search"],
    compatibleTasks: ["content", "*"],
    systemInstructions: "Structure Hn, mots-clés, méta-description.",
    executionInstructions: "Vérifie la densité de mots-clés avant de livrer.",
    evaluationCriteria: [" présence d'une méta-description "],
    status: "active",
    visibility: "system",
    authorId: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

beforeEach(() => {
  listSkillsMock.mockReset().mockResolvedValue([]);
});

describe("selectSkillsForObjective", () => {
  it("sélectionne les skills pertinentes et compose leurs instructions", async () => {
    listSkillsMock.mockResolvedValue([
      skill({ id: "s1", name: "Rédaction SEO" }),
      skill({ id: "s2", name: "Facture PDF", description: "Générer une facture", compatibleTasks: ["finance"], requiredTools: ["document.generate"] }),
    ]);

    const block = await selectSkillsForObjective({
      userId: "u1",
      objective: "Rédige un article optimisé sur les moteurs de recherche et la rédaction",
      taskType: "content",
    });

    expect(block).not.toBeNull();
    expect(block?.skillIds).toEqual(["s1"]);
    expect(block?.systemInstructions).toContain("Structure Hn");
    expect(block?.executionInstructions).toContain("densité de mots-clés");
    expect(block?.requiredTools).toEqual(["web.search"]);
  });

  it("cloisonnement : les skills privées d'AUTRUI ne sont jamais sélectionnées", async () => {
    listSkillsMock.mockResolvedValue([
      skill({ id: "other", name: "Rédaction SEO privée", visibility: "private", authorId: "u999" }),
      skill({ id: "mine", name: "Rédaction SEO à moi", visibility: "private", authorId: "u1" }),
    ]);

    const block = await selectSkillsForObjective({ userId: "u1", objective: "rédaction rédaction rédaction contenu", taskType: "*" });
    expect(block?.skillIds).toEqual(["mine"]);
  });

  it("fail-soft : panne de lecture → null (le runtime n'en dépend jamais)", async () => {
    listSkillsMock.mockRejectedValue(new Error("firestore down"));
    expect(await selectSkillsForObjective({ userId: "u1", objective: "n'importe quel objectif long" })).toBeNull();
  });

  it("aucune skill compatible → null", async () => {
    listSkillsMock.mockResolvedValue([
      skill({ id: "s1", compatibleTasks: ["finance"], name: "Facture" }),
    ]);
    expect(await selectSkillsForObjective({ userId: "u1", objective: "rédige un article de blog long", taskType: "content" })).toBeNull();
  });

  it("plafond : au plus 3 skills par mission", async () => {
    const many = Array.from({ length: 6 }, (_, index) =>
      skill({ id: `s${index}`, name: `Skill rédaction ${index}`, compatibleTasks: ["*"] }),
    );
    listSkillsMock.mockResolvedValue(many);
    const block = await selectSkillsForObjective({ userId: "u1", objective: "rédaction rédaction rédaction", maxSkills: 10 });
    expect(block?.skillIds.length).toBeLessThanOrEqual(3);
  });
});

describe("formatSkillsSection", () => {
  it("bloc vide si pas de skills, sections complètes sinon", () => {
    expect(formatSkillsSection(null)).toBe("");
    const section = formatSkillsSection({
      skillIds: ["s1"],
      skillNames: ["Rédaction SEO"],
      systemInstructions: "Instr S.",
      executionInstructions: "Instr E.",
      requiredTools: ["web.search"],
      evaluationCriteria: [],
    });
    expect(section).toContain("SKILLS ACTIVES");
    expect(section).toContain("Rédaction SEO");
    expect(section).toContain("web.search");
  });
});
