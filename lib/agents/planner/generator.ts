import { generate } from "@/lib/ai/router";
import {
  DynamicPlan,
  DynamicPlanSchema,
} from "./schema";

import {
  extractJsonObject,
  fallbackPlanSteps,
  normalizePlanSteps,
} from "./normalize";

export interface PlanGenerationInput {
  objective: string;

  tools: Array<{
    name: string;
    description: string;
    risk: string;
  }>;

  skills: Array<{
    id: string;
    name: string;
    description: string;
    capabilities: string[];
  }>;

  /**
   * Sous-agents délégables (identité + spécialité du propriétaire).
   * Une étape type "agent" avec agentId = id du sous-agent délègue la
   * tâche à cet agent (réponse LLM avec ses propres instructions).
   */
  subAgents?: Array<{
    id: string;
    name: string;
    description: string;
    typeLabel?: string;
  }>;
}

const SYSTEM_PROMPT = "You are Gen3ia Planner. Output valid JSON only.";

function buildPrompt(input: PlanGenerationInput, correctiveHint?: string): string {
  return `
You are the Gen3ia autonomous planning engine.

Your task is to transform the user objective into
a valid executable DAG.

USER OBJECTIVE:
${input.objective}

AVAILABLE TOOLS:
${JSON.stringify(
  input.tools,
  null,
  2,
)}

AVAILABLE SKILLS:
${JSON.stringify(
  input.skills,
  null,
  2,
)}

AVAILABLE SUB-AGENTS (delegation):
${input.subAgents && input.subAgents.length > 0
  ? JSON.stringify(input.subAgents, null, 2)
  : "none — do NOT use step type \"agent\""}

RULES:

1. Produce only executable steps.
2. Every step must have a unique ID.
3. Dependencies must reference existing steps.
4. Never create a dependency cycle.
5. Use parallel steps when they are independent.
6. Never invent tools.
7. Never invent skills.
8. Use research steps for external factual research.
9. Use document steps when a document must be created.
10. Mark sideEffect=true for irreversible/external actions.
11. Mark requiresApproval=true for sensitive actions.
12. Keep the plan as small as possible.
13. Use dependencies to transfer outputs between steps.
14. Prefer deterministic tool execution over hallucinated tool results.
15. Use step type "agent" (with agentId) ONLY to delegate a self-contained sub-task to one of the AVAILABLE SUB-AGENTS listed above. Never delegate to an agent not in the list. A sub-agent answers with its expertise; it cannot execute tools itself.
16. maxConcurrency must be between 1 and 8.
17. maxIterations must be between 1 and 20.

Return ONLY valid JSON.
${correctiveHint ? `\nIMPORTANT — your previous response was rejected:\n${correctiveHint}\nFix it and return valid JSON again.\n` : ""}`;
}

async function callPlanner(input: PlanGenerationInput, correctiveHint?: string) {
  return generate({
    task: "reasoning",

    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildPrompt(input, correctiveHint) },
    ],
  });
}

/**
 * Tente de construire un DynamicPlan valide à partir d'une réponse LLM :
 * extraction JSON défensive + normalisation des étapes + validation schéma.
 * Retourne l'erreur exacte si rien n'est récupérable (pour la tentative
 * corrective suivante).
 */
async function parsePlanResponse(text: string): Promise<DynamicPlan> {
  const parsed = extractJsonObject(text);
  const candidate = (parsed && typeof parsed === "object" && Array.isArray((parsed as { steps?: unknown }).steps))
    ? { ...(parsed as Record<string, unknown>), steps: normalizePlanSteps((parsed as { steps: unknown }).steps) }
    : parsed;
  const result = DynamicPlanSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(`Invalid generated plan: ${result.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return result.data;
}

export async function generatePlan(
  input: PlanGenerationInput,
): Promise<DynamicPlan> {
  // Résilience : le planning ne doit jamais faire échouer la création d'une
  // mission à cause d'une sortie LLM malformée ou d'une panne ponctuelle.
  // Stratégie en 3 paliers :
  //   1. tentative initiale ;
  //   2. 1 tentative corrective (l'erreur est renvoyée au modèle) ;
  //   3. plan de repli déterministe (une étape LLM sur l'objectif) —
  //      l'utilisateur obtient une mission exécutable au lieu d'une erreur.
  const tentatives = 2;
  let dernierErreur = "";

  for (let essai = 1; essai <= tentatives; essai++) {
    try {
      const response = await callPlanner(input, essai > 1 ? dernierErreur : undefined);
      return await parsePlanResponse(response.text);
    } catch (error) {
      dernierErreur = error instanceof Error ? error.message : String(error);
      // Diagnostic : sans ce log, un repli silencieux est indiscernable d'une
      // panne provider (403/timeout) ou d'une sortie LLM hors schéma.
      console.warn(`[planner] Tentative ${essai}/${tentatives} échouée:`, dernierErreur);
    }
  }

  // Palier final : plan de repli déterministe, toujours valide par
  // construction (une étape llm, aucun outil/skill inventé).
  const fallback = DynamicPlanSchema.safeParse({
    objective: input.objective,
    reasoning: "Plan de repli : le moteur de planning n'a pas répondu correctement.",
    steps: fallbackPlanSteps(input.objective),
    maxConcurrency: 1,
    maxIterations: 1,
    estimatedCredits: 0,
  });
  if (fallback.success) return fallback.data;

  // Inatteignable en pratique (le repli est valide par construction) mais
  // on ne masque jamais silencieusement une erreur de programmation.
  throw new Error(`Planner failed: ${dernierErreur}`);
}
