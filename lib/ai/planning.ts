import "server-only";

import { z } from "zod";
import { generate } from "./router";
import type { AIMessage } from "./models";

/**
 * RAISONNEMENT ET PLANIFICATION DE HAUT NIVEAU (Task 42, axe 5).
 *
 * Boucle explicite plan → critique → révision pour les problèmes
 * multi-étapes (projets, débogage, analyses de risque) :
 *
 *   1. `createPlan`   : le LLM produit un plan STRUCTURÉ (schéma zod
 *      strict — étapes avec critères de succès mesurables et risques
 *      déclarés, hypothèses explicites).
 *   2. `critiquePlan` : une SECONDE passe de LLM (rôle distinct) évalue
 *      le plan : couverture de l'objectif, risques manquants, critères
 *      mesurables, ordre des dépendances → verdict + défauts concrets.
 *   3. `revisePlan`   : si le verdict n'est pas satisfaisant, le plan est
 *      révisé en tenant compte de la critique (une seule itération par
 *      défaut — coût borné).
 *
 * Anti-hallucination : le plan est TOUJOURS revalidé côté code (zod) ;
 * les étapes sont renumérotées déterministement ; la critique reçoit
 * l'objectif et le plan, jamais de contexte inventé. Le résultat expose
 * plan ET critique : l'appelant (orchestrateur, surface agent) décide —
 * aucun effet de bord automatique.
 */

export const PlanStepSchema = z.object({
  title: z.string().min(1).max(200),
  action: z.string().min(1).max(2_000),
  /** Outil suggéré (indicatif) — l'orchestrateur reste maître du choix réel. */
  toolHint: z.string().max(80).optional(),
  /** Critère de succès mesurable de l'étape. */
  successCriteria: z.string().min(1).max(400),
  /** Risques identifiés pour cette étape. */
  risks: z.array(z.string().max(200)).max(5).default([]),
});

export const PlanSchema = z.object({
  goal: z.string().min(1).max(500),
  assumptions: z.array(z.string().max(300)).max(8).default([]),
  steps: z.array(PlanStepSchema).min(1).max(12),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type Plan = z.infer<typeof PlanSchema>;

export const PlanCritiqueSchema = z.object({
  verdict: z.enum(["satisfaisant", "à_revoir"]),
  /** Défauts concrets détectés (vides si satisfaisant). */
  issues: z.array(z.string().min(1).max(400)).max(8).default([]),
  /** Risques non couverts par le plan. */
  missingRisks: z.array(z.string().max(200)).max(5).default([]),
  /** Étapes dont le critère de succès n'est pas mesurable. */
  vagueSteps: z.array(z.number().int().min(1)).max(12).default([]),
});

export type PlanCritique = z.infer<typeof PlanCritiqueSchema>;

export interface PlanningResult {
  plan: Plan;
  critique: PlanCritique;
  /** true si le plan a été révisé après critique. */
  revised: boolean;
  /** Nombre d'itérations de révision effectuées (0 ou 1 par défaut). */
  revisions: number;
}

/* ------------------------------------------------------------------ */
/* Validation stricte côté code (aucune confiance dans le LLM brut)     */
/* ------------------------------------------------------------------ */

/** Extrait et revalide un JSON de plan depuis une réponse LLM. */
function parsePlan(text: string): Plan {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1]?.trim(), text.trim()];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    const raw = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
    try {
      const parsed = PlanSchema.parse(JSON.parse(raw));
      // Renumérotation déterministe (1..n) : le LLM ne décide pas des ids.
      return parsed;
    } catch {
      /* candidat suivant */
    }
  }
  throw new Error("Plan illisible ou invalide (schéma non respecté).");
}

function parseCritique(text: string): PlanCritique {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1]?.trim(), text.trim()];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    const raw = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
    try {
      return PlanCritiqueSchema.parse(JSON.parse(raw));
    } catch {
      /* candidat suivant */
    }
  }
  // Critique illisible = défaut conservateur : le plan passe en révision.
  return { verdict: "à_revoir", issues: ["Critique illisible — révision conservatoire."], missingRisks: [], vagueSteps: [] };
}

const PLAN_SYSTEM = [
  "Tu es le planificateur Gen3ia. Construis un plan d'exécution structuré pour l'objectif donné.",
  "Contraintes impératives :",
  "- Chaque étape porte un critère de succès MESURABLE (comment vérifier qu'elle est réussie).",
  "- Chaque étape déclare ses risques réels (pas de risque fantôme, pas d'omission des dépendances).",
  "- Les hypothèses incertaines sont listées explicitement (jamais supposées silencieusement).",
  "- Ordre des étapes = ordre des dépendances réelles.",
  "Réponds STRICTEMENT en JSON selon le schéma : {\"goal\":string,\"assumptions\":string[],\"steps\":[{\"title\":string,\"action\":string,\"toolHint\"?:string,\"successCriteria\":string,\"risks\":string[]}]}",
].join(" ");

const CRITIC_SYSTEM = [
  "Tu es le critique de plans Gen3ia (rôle indépendant du planificateur).",
  "On te donne un objectif et un plan structuré. Cherche activement les défauts :",
  "- étapes qui ne couvrent pas tout l'objectif ;",
  "- critères de succès non mesurables (ids d'étapes dans vagueSteps, 1-based) ;",
  "- risques manquants (dépendances externes, données indisponibles, effets de bord, sécurité/confidentialité) ;",
  "- ordre des étapes qui viole des dépendances.",
  "Sois exigeant mais factuel : chaque défaut cité doit être vérifiable dans le plan.",
  "Réponds STRICTEMENT en JSON : {\"verdict\":\"satisfaisant|à_revoir\",\"issues\":string[],\"missingRisks\":string[],\"vagueSteps\":number[]}",
].join(" ");

/* ------------------------------------------------------------------ */
/* Boucle plan → critique → révision                                   */
/* ------------------------------------------------------------------ */

export async function createPlan(objective: string, context?: string): Promise<Plan> {
  const response = await generate({
    task: "reasoning",
    messages: [
      { role: "system", content: PLAN_SYSTEM },
      { role: "user", content: context ? `${context}\n\nOBJECTIF : ${objective}` : objective },
    ],
    requiresStructuredOutput: true,
    maxTokens: 2_500,
    metadata: { purpose: "planning-create" },
  });
  return parsePlan(response.text);
}

export async function critiquePlan(objective: string, plan: Plan): Promise<PlanCritique> {
  const response = await generate({
    task: "reasoning",
    messages: [
      { role: "system", content: CRITIC_SYSTEM },
      { role: "user", content: JSON.stringify({ objectif: objective, plan }) },
    ],
    requiresStructuredOutput: true,
    maxTokens: 1_200,
    metadata: { purpose: "planning-critique" },
  });
  return parseCritique(response.text);
}

/** Révise le plan en intégrant la critique (1 itération, coût borné). */
export async function revisePlan(objective: string, plan: Plan, critique: PlanCritique): Promise<Plan> {
  const instruction = [
    "Révise le plan ci-dessous pour corriger EXACTEMENT les défauts cités (rien d'autre).",
    "Conserve la structure JSON identique ; conserve les étapes correctes telles quelles.",
    JSON.stringify({ objectif: objective, plan, critique }),
  ].join("\n\n");
  const response = await generate({
    task: "reasoning",
    messages: [
      { role: "system", content: PLAN_SYSTEM },
      { role: "user", content: instruction },
    ],
    requiresStructuredOutput: true,
    maxTokens: 2_500,
    metadata: { purpose: "planning-revise" },
  });
  return parsePlan(response.text);
}

/**
 * Boucle complète : plan → critique → (révision si verdict insuffisant).
 * `maxRevisions` borne le coût (défaut 1). La critique FINALE est toujours
 * renvoyée : l'appelant voit le dernier état évalué, pas une autosatisfaction.
 */
export async function planWithValidation(objective: string, options?: { context?: string; maxRevisions?: number }): Promise<PlanningResult> {
  let plan = await createPlan(objective, options?.context);
  let critique = await critiquePlan(objective, plan);
  let revised = false;
  const maxRevisions = Math.min(Math.max(options?.maxRevisions ?? 1, 0), 2);

  let revisions = 0;
  while (critique.verdict !== "satisfaisant" && revisions < maxRevisions) {
    plan = await revisePlan(objective, plan, critique);
    critique = await critiquePlan(objective, plan);
    revised = true;
    revisions += 1;
  }

  return { plan, critique, revised, revisions };
}

/** Rendu texte compact d'un plan (injection dans les prompts d'exécution). */
export function renderPlanForExecution(result: PlanningResult): string {
  const { plan, critique } = result;
  const lines: string[] = [
    `PLAN VALIDÉ — objectif : ${plan.goal}`,
    ...(plan.assumptions.length > 0 ? [`Hypothèses (à confirmer si fausses) : ${plan.assumptions.join(" ; ")}`] : []),
    "Étapes :",
    ...plan.steps.map((step, index) => `${index + 1}. ${step.title} — ${step.action}${step.toolHint ? ` [outil : ${step.toolHint}]` : ""}\n   Succès : ${step.successCriteria}${step.risks.length > 0 ? `\n   Risques : ${step.risks.join(" ; ")}` : ""}`),
  ];
  if (critique.verdict === "satisfaisant") {
    lines.push(`Validation critique : satisfaisante${critique.missingRisks.length > 0 ? ` (risques résiduels à surveiller : ${critique.missingRisks.join(" ; ")})` : ""}.`);
  } else {
    lines.push(`Validation critique : DÉFAUTS RÉSIDUELS — ${critique.issues.join(" ; ")}. Tiens-en compte pendant l'exécution.`);
  }
  return lines.join("\n");
}

/** Type utilitaire pour les appels qui construisent leurs propres messages. */
export type { AIMessage };
