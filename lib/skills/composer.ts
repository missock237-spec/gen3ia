import type {
  SkillDefinitionInput,
} from "./schema";

export interface ComposedSkillPackage {
  skills: SkillDefinitionInput[];

  systemInstructions: string;

  executionInstructions: string;

  requiredTools: string[];

  evaluationCriteria: string[];

  executionOrder: string[];
}

export function composeSkills(
  skills: SkillDefinitionInput[],
): ComposedSkillPackage {
  if (skills.length === 0) {
    throw new Error(
      "At least one skill is required.",
    );
  }

  const ordered = [...skills].sort(
    (a, b) => {
      const aIndex =
        a.category === "foundation" ? 0 : 1;

      const bIndex =
        b.category === "foundation" ? 0 : 1;

      return aIndex - bIndex;
    },
  );

  const tools = new Set<string>();

  const criteria = new Set<string>();

  for (const skill of ordered) {
    for (const tool of skill.requiredTools) {
      tools.add(tool);
    }

    for (const criterion of skill.evaluationCriteria) {
      criteria.add(criterion);
    }
  }

  return {
    skills: ordered,

    systemInstructions:
      ordered
        .map(
          (skill) =>
            `## ${skill.name}\n${skill.systemInstructions}`,
        )
        .join("\n\n"),

    executionInstructions:
      ordered
        .map(
          (skill) =>
            `### ${skill.name}\n${skill.executionInstructions}`,
        )
        .join("\n\n"),

    requiredTools: [...tools],

    evaluationCriteria: [...criteria],

    executionOrder: ordered.map(
      (skill) => skill.id,
    ),
  };
}
