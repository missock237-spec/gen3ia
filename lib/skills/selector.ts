import {
  listSkills,
} from "./repository";

import {
  buildSkillSearchText,
  createEmbedding,
  similarity,
} from "./semantic";

import type {
  SkillDefinitionInput,
} from "./schema";

export interface SkillSelectionRequest {
  objective: string;
  taskType: string;

  requiredCapabilities?: string[];

  requiredTools?: string[];

  maxSkills?: number;
}

export interface SelectedSkill {
  skill: SkillDefinitionInput;
  score: number;
  reason: string;
}

function capabilityMatch(
  skill: SkillDefinitionInput,
  requested: string[],
): number {
  if (requested.length === 0) {
    return 1;
  }

  const available =
    skill.capabilities.map(
      (item) => item.name.toLowerCase(),
    );

  const matches = requested.filter((item) =>
    available.includes(item.toLowerCase()),
  );

  return matches.length / requested.length;
}

function toolMatch(
  skill: SkillDefinitionInput,
  requested: string[],
): number {
  if (requested.length === 0) {
    return 1;
  }

  const available =
    skill.requiredTools.map((item) =>
      item.toLowerCase(),
    );

  const matches = requested.filter((item) =>
    available.includes(item.toLowerCase()),
  );

  return matches.length / requested.length;
}

export async function selectSkills(
  request: SkillSelectionRequest,
): Promise<SelectedSkill[]> {
  const skills = await listSkills({
    status: "active",
  });

  const compatible = skills.filter((skill) => {
    return (
      skill.compatibleTasks.includes(
        request.taskType,
      ) ||
      skill.compatibleTasks.includes("*")
    );
  });

  if (compatible.length === 0) {
    return [];
  }

  const queryEmbedding =
    await createEmbedding(
      `${request.objective}\nTask: ${request.taskType}`,
    );

  const results: SelectedSkill[] = [];

  for (const skill of compatible) {
    const text = buildSkillSearchText(skill);

    const embedding =
      await createEmbedding(text);

    const semanticScore =
      similarity(
        queryEmbedding,
        embedding,
      );

    const capabilitiesScore =
      capabilityMatch(
        skill,
        request.requiredCapabilities ?? [],
      );

    const toolsScore =
      toolMatch(
        skill,
        request.requiredTools ?? [],
      );

    const score =
      semanticScore * 0.6 +
      capabilitiesScore * 0.25 +
      toolsScore * 0.15;

    results.push({
      skill,
      score,
      reason:
        `semantic=${semanticScore.toFixed(3)}, ` +
        `capabilities=${capabilitiesScore.toFixed(3)}, ` +
        `tools=${toolsScore.toFixed(3)}`,
    });
  }

  results.sort(
    (a, b) => b.score - a.score,
  );

  return results.slice(
    0,
    request.maxSkills ?? 5,
  );
}
