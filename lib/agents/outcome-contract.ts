import { z } from "zod";

import { generateForUser } from "@/lib/billing/ai-execution";

import type { RuntimeExecutionState } from "./runtime/types";

/**
 * CONTRAT DE RÉSULTAT (concepts post-SaaS #1 « Goal-as-a-Service » et #2
 * « Outcome-as-a-Service »).
 *
 * Une mission Gen3ia ne se déclare plus « completed » parce que ses étapes
 * se sont terminées sans erreur : elle peut porter un CONTRAT — une liste de
 * critères d'acceptation MESURABLES que le livrable doit satisfaire. La
 * porte de sortie du runtime (voir AgentRuntime) bloque l'état « completed »
 * tant que les critères ne sont pas vérifiés :
 *
 *  - critères DÉTERMINISTES (contient / ne contient pas / expression
 *    régulière / longueur minimale / format de livrable) : vérifiés en
 *    local, sans appel LLM, à coût nul et reproductibles ;
 *  - critères SÉMANTIQUES (kind "llm") : un juge LLM unique, facturé au
 *    propriétaire, rend un verdict JSON par critère — jamais d'auto-évaluation
 *    du modèle qui a produit le livrable sans contrat explicite.
 *
 * Le juge reçoit les SORTIES RÉELLES des étapes (jamais les promesses du
 * plan) et l'objectif. Toute panne du mécanisme de vérification est rendue
 * HONNÊTEMENT (`unavailable: true`) : la mission garde son statut naturel —
 * une panne d'infrastructure de vérification ne détruit jamais un travail
 * payant qui a réussi, mais elle n'est JAMAIS présentée comme « critères
 * atteints ».
 */

/* ------------------------------------------------------------------ */
/* Schéma du contrat                                                    */
/* ------------------------------------------------------------------ */

export const OutcomeCriterionKindSchema = z.enum([
  "llm",
  "contains",
  "not_contains",
  "regex",
  "min_length",
  "artifact_format",
]);

export const OutcomeCriterionSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_-]+$/, "Identifiant de critère alphanumérique attendu"),
    description: z.string().trim().min(3).max(500),
    kind: OutcomeCriterionKindSchema,
    /** Paramètre des critères textuels : motif attendu / interdit / regex. */
    pattern: z.string().min(1).max(500).optional(),
    /** Paramètre du critère min_length : longueur minimale du livrable. */
    minLength: z.number().int().positive().max(1_000_000).optional(),
    /** Paramètre du critère artifact_format : format de livrable attendu. */
    format: z.string().trim().min(1).max(40).optional(),
    /** Un critère non requis (avertissement) ne bloque pas la porte. */
    required: z.boolean().default(true),
  })
  .superRefine((criterion, ctx) => {
    if (
      (criterion.kind === "contains" || criterion.kind === "not_contains" || criterion.kind === "regex") &&
      !criterion.pattern
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pattern"], message: `Le critère ${criterion.kind} exige un motif` });
    }
    if (criterion.kind === "min_length" && !criterion.minLength) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["minLength"], message: "Le critère min_length exige une longueur minimale" });
    }
    if (criterion.kind === "artifact_format" && !criterion.format) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["format"], message: "Le critère artifact_format exige un format" });
    }
  });

export const OutcomeContractSchema = z.object({
  criteria: z.array(OutcomeCriterionSchema).min(1).max(10),
  /** « retry_once » (défaut) : une passe de correction automatique avant échec. */
  failPolicy: z.enum(["retry_once", "fail"]).default("retry_once"),
});

export type OutcomeCriterion = z.infer<typeof OutcomeCriterionSchema>;
export type OutcomeContract = z.infer<typeof OutcomeContractSchema>;

/** Parse la charge utile d'une route avec messages d'erreur lisibles. */
export function parseOutcomeContractInput(value: unknown): { contract?: OutcomeContract; error?: string } {
  const parsed = OutcomeContractSchema.safeParse(value);
  if (parsed.success) return { contract: parsed.data };
  const issue = parsed.error.issues[0];
  const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return { error: `${path}${issue.message}`.slice(0, 300) };
}

/* ------------------------------------------------------------------ */
/* Vérification                                                         */
/* ------------------------------------------------------------------ */

export interface OutcomeCriterionResult {
  criterionId: string;
  passed: boolean;
  /** Détail factuel du verdict (jamais de binaire, plafonné). */
  detail: string;
}

export interface OutcomeVerification {
  passed: boolean;
  /** true : le mécanisme de vérification lui-même a échoué — porte levée, verdict rendu honnêtement. */
  unavailable?: boolean;
  summary: string;
  results: OutcomeCriterionResult[];
}

/** Types d'étapes dont la sortie constitue le livrable de la mission. */
const DELIVERABLE_TYPES = new Set(["llm", "document", "media", "research"]);

const EVIDENCE_OUTPUT_LIMIT = 12_000;
const DETAIL_LIMIT = 300;

/**
 * Preuve soumise aux critères : les sorties des étapes livrables complétées
 * (concaténées, plafonnées) — à défaut, toutes les sorties sérialisées. Ce
 * sont les RÉSULTATS, jamais le plan ni les descriptions.
 */
export function collectOutcomeEvidence(state: RuntimeExecutionState): string {
  const deliverableOutputs: string[] = [];
  for (const step of state.plan.steps) {
    if (step.status !== "completed" || !DELIVERABLE_TYPES.has(step.type)) continue;
    const output = state.outputs[step.id];
    if (typeof output === "string" && output.trim()) deliverableOutputs.push(output);
    else if (output !== undefined && output !== null) {
      try {
        deliverableOutputs.push(JSON.stringify(output));
      } catch {
        /* sortie non sérialisable : ignorée comme preuve */
      }
    }
  }
  const joined = deliverableOutputs.join("\n\n");
  if (joined.trim()) return joined.slice(0, EVIDENCE_OUTPUT_LIMIT);
  const fallback: string[] = [];
  for (const step of state.plan.steps) {
    const output = state.outputs[step.id];
    if (typeof output === "string" && output.trim()) fallback.push(output);
  }
  return fallback.join("\n\n").slice(0, EVIDENCE_OUTPUT_LIMIT);
}

function checkDeterministicCriterion(criterion: OutcomeCriterion, evidence: string, state: RuntimeExecutionState): OutcomeCriterionResult {
  const detail = (passed: boolean, text: string): OutcomeCriterionResult => ({
    criterionId: criterion.id,
    passed,
    detail: text.slice(0, DETAIL_LIMIT),
  });
  switch (criterion.kind) {
    case "contains":
      return detail(evidence.includes(criterion.pattern ?? ""), `Motif « ${(criterion.pattern ?? "").slice(0, 100)} » ${evidence.includes(criterion.pattern ?? "") ? "présent" : "absent"} du livrable.`);
    case "not_contains":
      return detail(!evidence.includes(criterion.pattern ?? ""), `Motif interdit « ${(criterion.pattern ?? "").slice(0, 100)} » ${evidence.includes(criterion.pattern ?? "") ? "ENCORE PRÉSENT" : "absent"} du livrable.`);
    case "regex": {
      if (evidence.length > 0 && (criterion.pattern ?? "").length > 0) {
        try {
          const regex = new RegExp(criterion.pattern ?? "", "u");
          return detail(regex.test(evidence.slice(0, 100_000)), `Expression régulière ${regex.test(evidence.slice(0, 100_000)) ? "satisfaite" : "non satisfaite"}.`);
        } catch {
          return detail(false, "Expression régulière invalide — critère mal configuré.");
        }
      }
      return detail(false, "Expression régulière non évaluable.");
    }
    case "min_length": {
      const minimum = criterion.minLength ?? 0;
      return detail(evidence.length >= minimum, `Livrable de ${evidence.length} caractères (minimum requis : ${minimum}).`);
    }
    case "artifact_format": {
      // Un format de livrable attendu : au moins une étape document
      // complétée doit déclarer ce format (input.format, comparaison
      // insensible à la casse).
      const expected = (criterion.format ?? "").toLowerCase();
      const declared = state.plan.steps
        .filter((step) => step.status === "completed" && step.type === "document")
        .map((step) => (typeof step.input?.format === "string" ? step.input.format.toLowerCase() : ""))
        .filter(Boolean);
      if (declared.length === 0) {
        return detail(false, `Aucun livrable document produit — format « ${criterion.format} » non atteint.`);
      }
      return detail(declared.includes(expected), `Format ${declared.includes(expected) ? "conforme" : `non conforme (produit : ${declared.join(", ")})`} — attendu : ${criterion.format}.`);
    }
    case "llm":
      // Ne doit jamais être appelé ici (filtré en amont) — défensif.
      return detail(false, "Critère sémantique non évalué.");
  }
}

const JUDGE_SYSTEM =
  "Tu es le vérificateur de contrats de résultat de Gen3ia. On te donne une mission (objectif), " +
  "des critères d'acceptation numérotés et la SORTIE RÉELLE produite par les étapes de la mission. " +
  "Pour CHAQUE critère sémantique, rends un verdict strict fondé UNIQUEMENT sur la sortie réelle : " +
  "n'assume jamais qu'une information absente est correcte, n'invente aucune preuve. " +
  "Réponds UNIQUEMENT avec un objet JSON : { \"criteria\": [{ \"id\": string, \"passed\": boolean, \"detail\": string }] } — " +
  "un objet par critère évalué, le détail étant factuel et concis.";

const JUDGE_MAX_TOKENS = 1_500;

const JUDGE_VERDICT_SCHEMA = z.object({
  criteria: z
    .array(
      z.object({
        id: z.string().min(1),
        passed: z.boolean(),
        detail: z.string().max(600).default(""),
      }),
    )
    .min(1),
});

/** Extrait l'objet JSON d'une réponse LLM (balisage markdown ou prose autour) — retourne toujours une VALEUR parsée. */
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
  throw new Error("Réponse du juge non structurée (objet JSON attendu).");
}

export interface OutcomeJudgeUsage {
  chargeMinor: number;
  providerCostEur: number;
  inputTokens: number;
  outputTokens: number;
}

const ZERO_USAGE: OutcomeJudgeUsage = { chargeMinor: 0, providerCostEur: 0, inputTokens: 0, outputTokens: 0 };

/**
 * Vérifie le contrat contre l'état réel de l'exécution. Les critères
 * déterministes sont évalués localement ; les critères sémantiques (llm)
 * partagent UN appel de juge facturé. Ne lève JAMAIS : une panne du juge
 * rend `unavailable: true` (porte levée, verdict honnête).
 */
export async function verifyOutcomeCriteria(
  contract: OutcomeContract,
  state: RuntimeExecutionState,
  billing: { userId: string; executionId: string },
): Promise<{ verification: OutcomeVerification; usage: OutcomeJudgeUsage }> {
  const evidence = collectOutcomeEvidence(state);
  const results: OutcomeCriterionResult[] = [];
  const semantic = contract.criteria.filter((criterion) => criterion.kind === "llm");

  for (const criterion of contract.criteria) {
    if (criterion.kind === "llm") continue;
    results.push(checkDeterministicCriterion(criterion, evidence, state));
  }

  // Critères non requis (avertissements) : verdicts enregistrés, non bloquants.
  let usage: OutcomeJudgeUsage = ZERO_USAGE;

  if (semantic.length > 0) {
    if (!evidence.trim()) {
      for (const criterion of semantic) {
        results.push({ criterionId: criterion.id, passed: false, detail: "Aucune sortie à évaluer — le livrable est vide." });
      }
    } else {
      try {
        const billed = await generateForUser({
          userId: billing.userId,
          executionId: billing.executionId,
          complexity: 1,
          request: {
            task: "reasoning",
            messages: [
              { role: "system", content: JUDGE_SYSTEM },
              {
                role: "user",
                content: JSON.stringify({
                  objective: state.objective.slice(0, 4_000),
                  criteria: semantic.map((criterion) => ({ id: criterion.id, description: criterion.description })),
                  criteriaNonSemantiques: results.map((result) => ({ id: result.criterionId, verdict: result.passed ? "satisfait" : "non satisfait" })),
                  evidence: evidence.slice(0, EVIDENCE_OUTPUT_LIMIT),
                }),
              },
            ],
            maxTokens: JUDGE_MAX_TOKENS,
          },
        });
        usage = {
          chargeMinor: billed.chargeMinor,
          providerCostEur: billed.providerCostEur,
          inputTokens: billed.response.usage.inputTokens,
          outputTokens: billed.response.usage.outputTokens,
        };
        const parsed = JUDGE_VERDICT_SCHEMA.parse(extractJsonCandidate(billed.response.text));
        for (const criterion of semantic) {
          const verdict = parsed.criteria.find((entry) => entry.id === criterion.id);
          results.push(
            verdict
              ? { criterionId: criterion.id, passed: verdict.passed, detail: (verdict.detail || (verdict.passed ? "Critère satisfait." : "Critère non satisfait.")).slice(0, DETAIL_LIMIT) }
              : { criterionId: criterion.id, passed: false, detail: "Le juge n'a pas rendu de verdict pour ce critère — traité comme non satisfait." },
          );
        }
      } catch (error) {
        // Panne du juge : honnêteté — `unavailable`, jamais de faux « atteint ».
        return {
          verification: {
            passed: false,
            unavailable: true,
            summary: `Vérification du contrat indisponible : ${error instanceof Error ? error.message.slice(0, 200) : "erreur inconnue"}`,
            results,
          },
          usage,
        };
      }
    }
  }

  const blocking = results.filter((result) => {
    const criterion = contract.criteria.find((c) => c.id === result.criterionId);
    return result.passed === false && criterion?.required !== false;
  });

  const passed = blocking.length === 0;
  const failedIds = blocking.map((result) => result.criterionId).join(", ");
  return {
    verification: {
      passed,
      summary: passed
        ? `Contrat vérifié : ${results.length} critère(s) satisfait(s).`
        : `${blocking.length} critère(s) d'acceptation non atteint(s) : ${failedIds}`,
      results,
    },
    usage,
  };
}
