import { z } from "zod";

import { generateForUser } from "@/lib/billing/ai-execution";
import { getEvolutionBrief } from "@/lib/agents/evolution";

import type { RuntimeExecutionState, RuntimePlan, RuntimeStep } from "./types";

/**
 * REPLANIFICATION DYNAMIQUE (concept post-SaaS #10) : quand des étapes ont
 * échoué APRÈS l'épuisement de la réparation du critic, le runtime ne se
 * contente pas d'un simple reset — il RÉÉCRIT la suite du plan :
 *  - contexte réel : objectif, étapes réussies (avec leurs sorties), étapes
 *    en échec AVEC leurs messages d'erreur ;
 *  - leçons d'évolution : les clusters d'échec connus du principal
 *    (lib/agents/evolution) sont injectés — « écueils à ne pas répéter » ;
 *  - sortie bornée : 1 à 10 étapes séquentielles (DAG linéaire — jamais de
 *    cycle possible), types restreints (llm/research/document/tool), les
 *    outils restent soumis à la politique de sécurité au moment de
 *    l'exécution (authorizeTool s'applique normalement).
 *
 * Bornes : au plus UNE replanification par exécution (compteur runner), juge
 * en panne = échec honnête de la replanification (la mission garde son
 * échec réel), facturation réelle de l'appel de replanification.
 */

const REPLAN_MAX_STEPS = 10;

const REPLAN_SYSTEM =
  "Tu es le replanificateur du runtime Gen3ia. Une mission a échoué en partie. " +
  "Reçois l'objectif, les étapes déjà réussies (avec leurs sorties), les étapes en échec AVEC leurs erreurs " +
  "et les écueils connus de cet utilisateur. Écris la SUITE du plan qui atteint l'objectif en évitant les erreurs constatées : " +
  "change d'approche, corrige les entrées, découpe différemment — ne répète pas à l'identique ce qui a échoué. " +
  "Réponds UNIQUEMENT en JSON : { \"reasoning\": string, \"steps\": [{ \"type\": \"llm\"|\"research\"|\"document\"|\"tool\", \"name\": string, \"description\": string, \"toolName\": string }] } " +
  "— 1 à 10 étapes séquentielles, descriptions opérationnelles autonomes (l'agent n'a que ton texte), toolName requis UNIQUEMENT pour type \"tool\".";

const ReplanOutputSchema = z.object({
  reasoning: z.string().max(1_000).default(""),
  steps: z
    .array(
      z.object({
        type: z.enum(["llm", "research", "document", "tool"]),
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().min(3).max(2_000),
        toolName: z.string().trim().max(80).optional(),
      }),
    )
    .min(1)
    .max(REPLAN_MAX_STEPS),
});

function extractJsonCandidate(raw: string): unknown {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1]?.trim(), text].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(candidate.slice(start, end + 1));
        } catch {
          /* candidat suivant */
        }
      }
    }
  }
  throw new Error("Replanification non structurée (JSON attendu).");
}

const REPLAN_ALLOWED_TYPES = new Set(["llm", "research", "document", "tool"]);

export interface ReplanUsage {
  chargeMinor: number;
  providerCostEur: number;
  inputTokens: number;
  outputTokens: number;
}

/** Contexte réel injecté au replanificateur (jamais les promesses du plan). */
export function buildReplanContext(state: RuntimeExecutionState): { completed: Array<{ name: string; summary: string }>; failed: Array<{ name: string; error: string }> } {
  const completed: Array<{ name: string; summary: string }> = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const step of state.plan.steps) {
    if (step.status === "completed") {
      const output = state.outputs[step.id];
      const summary =
        typeof output === "string"
          ? output.slice(0, 400)
          : output !== undefined && output !== null
            ? JSON.stringify(output).slice(0, 400)
            : "terminée";
      completed.push({ name: step.name.slice(0, 120), summary });
    } else if (step.status === "failed") {
      const observation = state.observations.filter((entry) => entry.stepId === step.id && !entry.success).at(-1);
      failed.push({ name: step.name.slice(0, 120), error: (observation?.error ?? state.error ?? "erreur inconnue").slice(0, 300) });
    }
  }
  return { completed: completed.slice(0, 10), failed: failed.slice(0, 10) };
}

/**
 * Construit le plan REPLACÉ : les étapes réussies sont CONSERVÉES à
 * l'identique (leurs sorties restent dans outputs), les étapes en échec sont
 * substituées par la suite replanifiée (DAG linéaire validé localement).
 */
export async function buildReplan(
  state: RuntimeExecutionState,
  billing: { userId: string; executionId: string },
): Promise<{ plan: RuntimePlan; reasoning: string; usage: ReplanUsage }> {
  const context = buildReplanContext(state);
  const evolution = await getEvolutionBrief(billing.userId);

  const billed = await generateForUser({
    userId: billing.userId,
    executionId: billing.executionId,
    complexity: 1,
    request: {
      task: "reasoning",
      messages: [
        { role: "system", content: REPLAN_SYSTEM },
        {
          role: "user",
          content: JSON.stringify({
            objective: state.objective.slice(0, 2_000),
            stepsReussies: context.completed,
            stepsEnEchec: context.failed,
            ...(evolution.text ? { ecueilsConnus: evolution.text } : {}),
          }),
        },
      ],
      maxTokens: 1_600,
    },
  });

  const usage: ReplanUsage = {
    chargeMinor: billed.chargeMinor,
    providerCostEur: billed.providerCostEur,
    inputTokens: billed.response.usage.inputTokens,
    outputTokens: billed.response.usage.outputTokens,
  };

  const parsed = ReplanOutputSchema.parse(extractJsonCandidate(billed.response.text));

  const preserved = state.plan.steps.filter((step) => step.status === "completed" || step.status === "skipped");
  const newSteps: RuntimeStep[] = parsed.steps.map((step, index) => ({
    id: `replan_${index + 1}`,
    type: REPLAN_ALLOWED_TYPES.has(step.type) ? step.type : "llm",
    name: step.name,
    description:
      step.description +
      (index === 0 && (context.failed.length > 0 || context.completed.length > 0)
        ? `\nContexte : les étapes réussies ont produit des résultats disponibles ; échecs constatés à éviter : ${context.failed.map((failure) => `${failure.name} (${failure.error})`).join(" ; ").slice(0, 800)}`
        : ""),
    dependencies: index === 0 ? [] : [`replan_${index}`],
    status: "pending",
    input: step.type === "tool" && step.toolName ? { toolName: step.toolName } : {},
    skillIds: [],
    maxRetries: 2,
    timeoutMs: 120_000,
    sideEffect: false,
    requiresApproval: false,
    ...(step.type === "tool" && step.toolName ? { toolName: step.toolName } : {}),
  }));

  const plan: RuntimePlan = {
    executionId: state.plan.executionId,
    objective: state.plan.objective,
    steps: [...preserved, ...newSteps],
    maxConcurrency: state.plan.maxConcurrency,
    maxIterations: Math.max(state.plan.maxIterations, newSteps.length + 4),
  };

  return { plan, reasoning: parsed.reasoning, usage };
}
