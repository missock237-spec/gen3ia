import {
  SkillDefinition,
  SkillSelection
} from "./types";

export class SkillEngine {
  private readonly skills: SkillDefinition[];

  constructor(skills: SkillDefinition[]) {
    this.skills = skills.filter(
      (skill) => skill.enabled
    );
  }

  selectSkills(
    task: string,
    capabilities: string[]
  ): SkillSelection[] {
    const normalizedTask =
      task.toLowerCase();

    return this.skills
      .map((skill) => {
        let relevance = 0;
        const reasons: string[] = [];

        for (const trigger of skill.triggers) {
          if (
            normalizedTask.includes(
              trigger.toLowerCase()
            )
          ) {
            relevance += 25;
            reasons.push(
              `trigger:${trigger}`
            );
          }
        }

        for (const capability of capabilities) {
          if (
            skill.capabilities.includes(
              capability
            )
          ) {
            relevance += 15;
            reasons.push(
              `capability:${capability}`
            );
          }
        }

        return {
          skillId: skill.id,
          relevance,
          reason: reasons.join(", ")
        };
      })
      .filter(
        (result) => result.relevance > 0
      )
      .sort(
        (a, b) =>
          b.relevance - a.relevance
      );
  }

  compose(
    selections: SkillSelection[]
  ): string {
    return selections
      .map(
        (selection) =>
          `SKILL ${selection.skillId}\n${selection.reason}`
      )
      .join("\n\n");
  }
      }
