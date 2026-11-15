import { describe, expect, it, vi } from "vitest";

/**
 * Importateur skills.sh — conversion SKILL.md (format Agent Skills de
 * l'écosystème ouvert) vers le schéma de skills Gen3ia :
 * frontmatter YAML, corps Markdown, triggers EN extraits + synonymes FR,
 * version dérivée du contenu (idempotence), troncature bornée.
 */

const saveSkillMock = vi.fn();
vi.mock("./repository", () => ({
  saveSkill: (...args: unknown[]) => saveSkillMock(...args),
}));

import { convertSkillMarkdown, SKILLS_SH_ID_PREFIX } from "./sh-importer";

const SAMPLE = `---
name: code-review
description: Review pull requests with care. Use when asked to "review a PR", "check my code", or "audit changes".
metadata:
  author: mattpocock
  version: "1.0.0"
---

# Code Review

Review the pull request systematically.

## Steps

1. Read the diff fully before commenting.
2. Flag bugs, not style preferences.
`;

const NO_FRONTMATTER = `# Fallback Skill

Instructions sans frontmatter.`;

describe("convertSkillMarkdown", () => {
  it("convertit le frontmatter (name/description) et le corps", () => {
    const skill = convertSkillMarkdown("code-review", SAMPLE);
    expect(skill.id).toBe(`${SKILLS_SH_ID_PREFIX}code-review`);
    expect(skill.name).toBe("code-review");
    expect(skill.description).toContain("Review pull requests");
    expect(skill.executionInstructions).toContain("# Code Review");
    expect(skill.executionInstructions).toContain("Read the diff fully");
    expect(skill.status).toBe("active");
    expect(skill.visibility).toBe("system");
    expect(skill.authorId).toBeNull();
  });

  it("enrichit les triggers de synonymes français selon la catégorie", () => {
    const skill = convertSkillMarkdown("code-review", SAMPLE);
    // Catégorie code → vocabulaire FR (bug, corrige, fonction…)
    expect(skill.triggers).toContain("corrige");
    expect(skill.triggers).toContain("bug");
    // Triggers EN extraits du « Use when »
    expect(skill.triggers.some((trigger) => trigger.includes("review"))).toBe(true);
    expect(skill.compatibleTasks).toEqual(["*"]);
  });

  it("couvre les catégories média (rendu vidéo) en français — les skills IA média externes ont été retirées du catalogue", () => {
    const video = convertSkillMarkdown(
      "remotion-render",
      `---\nname: remotion-render\ndescription: Render videos with Remotion. Use when asked to "render a video".\n---\n\n# Render\n\nSteps.`,
    );
    expect(video.category).toBe("media");
    expect(video.triggers).toContain("vidéo");
    expect(video.triggers).toContain("montage");
  });

  it("repli propre sans frontmatter (titre H1)", () => {
    const skill = convertSkillMarkdown("custom", NO_FRONTMATTER);
    expect(skill.name).toBe("Fallback Skill");
    expect(skill.executionInstructions).toContain("Instructions sans frontmatter");
    expect(skill.systemInstructions).toContain("skills.sh");
  });

  it("tronque les instructions trop longues sans casser la structure", () => {
    const long = `---\nname: long\n description: d\n---\n\n${"paragraphe assez long. ".repeat(400)}`;
    const skill = convertSkillMarkdown("long", long);
    expect(skill.executionInstructions.length).toBeLessThanOrEqual(3_700);
    expect(skill.executionInstructions).toContain("Skill tronquée");
  });

  it("version stable dérivée du contenu (idempotence d'import)", () => {
    const first = convertSkillMarkdown("code-review", SAMPLE);
    const second = convertSkillMarkdown("code-review", SAMPLE);
    expect(first.version).toBe(second.version);
    const changed = convertSkillMarkdown("code-review", `${SAMPLE}\nChangement.`);
    expect(changed.version).not.toBe(first.version);
  });

  it("produit une définition valide pour le schéma plateforme", () => {
    const skill = convertSkillMarkdown("code-review", SAMPLE);
    // Contrats attendus par le pont runtime (runtime-bridge/composer).
    expect(typeof skill.systemInstructions).toBe("string");
    expect(skill.systemInstructions.length).toBeGreaterThan(0);
    expect(Array.isArray(skill.capabilities)).toBe(true);
    expect(skill.capabilities.length).toBeGreaterThan(0);
    expect(Array.isArray(skill.triggers)).toBe(true);
  });
});
