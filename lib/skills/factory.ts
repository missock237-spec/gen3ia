import { randomUUID } from "node:crypto";

import {
  SkillFactoryRequestSchema,
  SkillDefinitionSchema,
  type SkillDefinitionInput,
} from "./schema";

import {
  validateSkill,
} from "./validator";

export interface StructuredSkillGenerator {
  generate(
    prompt: string,
  ): Promise<unknown>;
}

function buildFactoryPrompt(
  request: ReturnType<
    typeof SkillFactoryRequestSchema.parse
  >,
): string {
  return `
You are the Gen3ia Skill Factory.

Create a production-grade reusable AI skill.

OBJECTIVE:
${request.objective}

TASK TYPE:
${request.taskType}

REQUIRED CAPABILITIES:
${request.requiredCapabilities.join(", ")}

REQUIRED TOOLS:
${request.requiredTools.join(", ")}

CONSTRAINTS:
${request.constraints.join("\n")}

EXPECTED OUTPUT:
${request.expectedOutput ?? "Not specified"}

Requirements:

1. The skill must be reusable.
2. Do not create a fake implementation.
3. Define precise inputs and outputs.
4. Define required tools.
5. Define compatible task types.
6. Define measurable evaluation criteria.
7. Include detailed system instructions.
8. Include detailed execution instructions.
9. Avoid hallucinated tools.
10. Do not claim access to tools that were not specified.
11. The skill must be deterministic where possible.
12. The skill must explicitly handle failures.

Return ONLY valid JSON matching the requested schema.
`;
}

export async function generateSkill(
  generator: StructuredSkillGenerator,
  requestInput: unknown,
  authorId: string,
): Promise<SkillDefinitionInput> {
  const request =
    SkillFactoryRequestSchema.parse(
      requestInput,
    );

  const raw =
    await generator.generate(
      buildFactoryPrompt(request),
    );

  const candidate = {
    ...(raw as Record<string, unknown>),

    id: `skill_${randomUUID()}`,

    version: 1,

    status: "testing",

    visibility: "private",

    authorId,

    createdAt: new Date().toISOString(),

    updatedAt: new Date().toISOString(),
  };

  const parsed =
    SkillDefinitionSchema.parse(
      candidate,
    );

  const validation =
    validateSkill(parsed);

  if (!validation.valid) {
    throw new Error(
      `Generated skill failed validation: ${validation.errors.join("; ")}`,
    );
  }

  return parsed;
}
