import {
  randomUUID,
} from "crypto";

import {
  getAvailableSkills,
} from "@/lib/skills/service";

import {
  buildPlannerToolContext,
} from "./context";

import {
  generatePlan,
} from "./generator";

import {
  validateGeneratedPlan,
} from "./validator";

import {
  fallbackPlanSteps,
} from "./normalize";

import {
  DynamicPlanSchema,
} from "./schema";

import {
  RuntimePlan,
} from "@/lib/agents/runtime";

/**
 * Plan de repli déterministe (une étape LLM) : garantit que la création de
 * tâche aboutit même quand le planning LLM est rejeté par la validation
 * (outil inventé, dépendance inconnue…). Toujours valide par construction.
 */
function planDeRepli(userId: string, objective: string): RuntimePlan {
  const parsed = DynamicPlanSchema.safeParse({
    objective,
    reasoning: "Plan de repli : le moteur de planning n'a pas produit de plan validable.",
    steps: fallbackPlanSteps(objective),
    maxConcurrency: 1,
    maxIterations: 1,
    estimatedCredits: 0,
  });
  if (parsed.success) {
    return {
      executionId: randomUUID(),
      objective,
      steps: parsed.data.steps.map((step) => ({ ...step, status: "pending" as const })),
      maxConcurrency: parsed.data.maxConcurrency,
      maxIterations: parsed.data.maxIterations,
    };
  }
  throw new Error("Generated plan rejected and fallback plan failed.");
}

export async function createAgentPlan(
  userId: string,
  objective: string,
): Promise<RuntimePlan> {
  const tools =
    buildPlannerToolContext();

  const skills =
    await getAvailableSkills(
      userId,
    );

  const generated =
    await generatePlan({
      objective,
      tools,

      skills: skills.map(
        (skill) => ({
          id: skill.id,
          name: skill.name,
          description:
            skill.description,
          capabilities:
            skill.capabilities.map(
              (capability) =>
                capability.name,
            ),
        }),
      ),
    });

  const validation =
    validateGeneratedPlan(
      generated,
      tools.map(
        (tool) => tool.name,
      ),
      skills.map(
        (skill) => skill.id,
      ),
    );

  if (!validation.valid) {
    // Repli déterministe plutôt qu'une erreur brute : l'utilisateur garde une
    // mission exécutable (l'audit du plan reste retracé dans les logs).
    console.warn("[planner] Generated plan rejected, using deterministic fallback:", validation.errors.join(" | "));
    return planDeRepli(userId, objective);
  }

  return {
    executionId:
      randomUUID(),

    objective,

    steps: generated.steps.map(
      (step) => ({
        ...step,

        status:
          "pending" as const,
      }),
    ),

    maxConcurrency:
      generated.maxConcurrency,

    maxIterations:
      generated.maxIterations,
  };
}
