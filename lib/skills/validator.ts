import {
  SkillDefinitionSchema,
} from "./schema";

export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateSkill(
  input: unknown,
): SkillValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const result =
    SkillDefinitionSchema.safeParse(input);

  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(
        `${issue.path.join(".")}: ${issue.message}`,
      );
    }

    return {
      valid: false,
      errors,
      warnings,
    };
  }

  const skill = result.data;

  if (
    skill.systemInstructions.length < 100
  ) {
    warnings.push(
      "System instructions are unusually short.",
    );
  }

  if (
    skill.executionInstructions.length < 100
  ) {
    warnings.push(
      "Execution instructions are unusually short.",
    );
  }

  if (skill.evaluationCriteria.length === 0) {
    errors.push(
      "A skill must define evaluation criteria.",
    );
  }

  if (skill.compatibleTasks.length === 0) {
    errors.push(
      "A skill must define compatible tasks.",
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
