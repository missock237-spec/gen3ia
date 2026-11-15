import { generate } from "@/lib/ai/router";

import {
  CriticResult,
  CriticResultSchema,
} from "./types";

export interface CriticInput {
  objective: string;

  stepOutputs: Record<
    string,
    unknown
  >;

  observations: unknown[];

  expectedQuality?: number;
}

export async function evaluateExecution(
  input: CriticInput,
): Promise<CriticResult> {
  const threshold =
    input.expectedQuality ?? 0.75;

  const prompt = `
You are the Gen3ia Quality Critic.

Evaluate whether the autonomous agent successfully
completed the user's objective.

OBJECTIVE:
${input.objective}

STEP OUTPUTS:
${JSON.stringify(
  input.stepOutputs,
  null,
  2,
)}

OBSERVATIONS:
${JSON.stringify(
  input.observations,
  null,
  2,
)}

PASSING THRESHOLD:
${threshold}

Evaluate:

1. Accuracy
2. Completeness
3. Relevance
4. Quality
5. Hallucination risk
6. Tool execution correctness
7. Format correctness
8. Constraint compliance
9. Security issues

Rules:

- Do not assume missing information is correct.
- Do not invent evidence.
- Identify exactly which steps are defective.
- Prefer correcting only defective steps.
- Retry should be false when the result is already sufficient.
- Critical security problems must fail the execution.
- Return ONLY valid JSON.

Required format:

{
  "score": 0.0,
  "passed": false,
  "summary": "...",
  "issues": [],
  "corrections": [],
  "retry": true,
  "retrySteps": []
}
`;

  const response =
    await generate({
      task: "reasoning",

      messages: [
        {
          role: "system",
          content:
            "You are a strict autonomous quality evaluator. Return JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

  let parsed: unknown;

  try {
    parsed = JSON.parse(
      response.text,
    );
  } catch {
    throw new Error(
      "Critic returned invalid JSON",
    );
  }

  const result =
    CriticResultSchema.safeParse(
      parsed,
    );

  if (!result.success) {
    throw new Error(
      `Invalid critic result: ${result.error.message}`,
    );
  }

  return result.data;
}
