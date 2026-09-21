import { randomUUID } from "node:crypto";
import { generate } from "@/lib/ai/router";
import type { AIProvider } from "@/lib/ai/models";
import { GEN3IA_TOOLS } from "@/lib/tools/registry";
import { AgentRuntime } from "./runner";
import { RuntimePlanSchema, type RuntimePlan } from "./types";
import { DEFAULT_EXECUTION_POLICY, type ExecutionPolicy } from "@/lib/security/execution-policy";

const MAX_OBJECTIVE_LENGTH = 20_000;
const MAX_PLAN_STEPS = 20;

const PLAN_SYSTEM = [
  "You are the Gen3ia universal agent planner.",
  "Every user request must be converted into a safe executable plan using only the capabilities listed below.",
  "Prefer the smallest number of steps and reuse previous outputs through dependencies.",
  "Use an llm step for reasoning or drafting, a research step for web research, a document step for document generation, a media step for media planning, a tool step for registered tools, and a code step only when isolated computation is necessary.",
  "Never invent a tool name.",
  "Never claim that an external action was completed unless the corresponding tool step succeeds.",
  "Mark sideEffect=true and requiresApproval=true for destructive, financial, credential, account-security, publication, deletion, external-account or other irreversible actions.",
  "Never request secrets in step inputs.",
  "Return JSON only with: executionId, objective, steps, maxConcurrency, maxIterations.",
].join(" ");

function toolCatalog(tools: typeof GEN3IA_TOOLS = GEN3IA_TOOLS): string {
  return tools.map((tool) =>
    `- ${tool.name}: ${tool.description}; risk=${tool.risk}; permission=${tool.permission}; sideEffect=${tool.sideEffect}`,
  ).join("\n");
}

/**
 * Extracts a JSON object from a model response. Providers occasionally wrap
 * JSON in markdown fences or prepend reasoning text despite
 * `response_format: json_object`; this defensive extractor finds the
 * outermost object instead of failing outright.
 */
function extractJsonObject(raw: string): unknown {
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
          // Try the next candidate.
        }
      }
    }
  }
  throw new Error("The agent planner returned invalid JSON.");
}

/** Maps fuzzy model step types onto the runtime's strict enum. */
const STEP_TYPE_ALIASES: Record<string, string> = {
  search: "research", web: "research", websearch: "research", research: "research",
  tool: "tool", tools: "tool",
  llm: "llm", text: "llm", reasoning: "llm", chat: "llm", answer: "llm", write: "llm", summary: "llm",
  document: "document", doc: "document", docs: "document",
  media: "media", image: "media",
  code: "code", compute: "code",
  condition: "condition",
};

/** Coerces any plausible planner output into schema-valid steps. */
function normalizeSteps(rawSteps: unknown): unknown[] {
  if (!Array.isArray(rawSteps)) return [];
  const knownIds = new Set<string>();
  const mapped = rawSteps.map((step, index) => {
    const base: Record<string, unknown> = (typeof step === "object" && step !== null)
      ? { ...(step as Record<string, unknown>) }
      : { description: String(step ?? "") };
    if (typeof base.id !== "string" || !base.id.trim()) base.id = `step-${index + 1}`;
    knownIds.add(String(base.id));
    return base;
  });

  for (const record of mapped) {
    const typeRaw = typeof record.type === "string" ? record.type.toLowerCase().replace(/[^a-z]/g, "") : "";
    record.type = STEP_TYPE_ALIASES[typeRaw] ?? "llm";
    if (record.type === "tool" && (typeof record.toolName !== "string" || !record.toolName.trim())) {
      // A tool step without a target is unusable: degrade to reasoning.
      record.type = "llm";
    }
    if (!record.status) record.status = "pending";
    const nameSource = [record.name, record.title, record.toolName, record.description].find(
      (value) => typeof value === "string" && value.trim(),
    );
    record.name = typeof nameSource === "string" ? nameSource.trim().slice(0, 120) : `Étape`;
    const descriptionSource = [record.description, record.name, record.objective].find(
      (value) => typeof value === "string" && value.trim(),
    );
    record.description = typeof descriptionSource === "string" ? descriptionSource.trim().slice(0, 600) : record.name;
    if (typeof record.input !== "object" || record.input === null || Array.isArray(record.input)) record.input = {};
    record.dependencies = Array.isArray(record.dependencies)
      ? (record.dependencies as unknown[]).map(String).filter((dep) => knownIds.has(dep))
      : [];
    if (record.skillIds !== undefined && !Array.isArray(record.skillIds)) delete record.skillIds;
    if (record.maxRetries !== undefined && !Number.isInteger(Number(record.maxRetries))) delete record.maxRetries;
    if (record.timeoutMs !== undefined && !Number.isFinite(Number(record.timeoutMs))) delete record.timeoutMs;
  }
  return mapped;
}

/**
 * Plan de repli déterministe : une seule étape llm portant l'objectif.
 * Toujours valide par construction — garantit qu'aucun plan invalide (en
 * particulier steps: []) n'atteint jamais le runtime, et que la demande de
 * l'utilisateur aboutit même quand le planificateur LLM déraille.
 */
function fallbackPlan(objective: string): RuntimePlan {
  return RuntimePlanSchema.parse({
    executionId: randomUUID(),
    objective,
    steps: [{
      id: "step-1",
      type: "llm",
      name: "Traiter la demande",
      description: `Exécuter l'objectif suivant de façon autonome : ${objective.slice(0, 300)}`,
      dependencies: [],
      input: { objective: objective.slice(0, 300) },
    }],
    maxConcurrency: 1,
    maxIterations: 1,
  });
}

export async function planUniversalAgent(
  userId: string,
  objective: string,
  options?: {
    policy?: ExecutionPolicy;
    signal?: AbortSignal;
    /** Contexte d'un agent personnalisé : charte de périmètre + whitelist d'outils. */
    agent?: { charter?: string; allowedTools?: string[] };
    provider?: AIProvider;
    model?: string;
  },
): Promise<RuntimePlan> {
  const trimmed = objective.trim();
  if (!trimmed || trimmed.length > MAX_OBJECTIVE_LENGTH) throw new Error("Invalid agent objective.");

  const agentContext = options?.agent;
  const allowedTools = agentContext?.allowedTools;
  const catalog = allowedTools
    ? GEN3IA_TOOLS.filter((tool) => allowedTools.includes(tool.name))
    : GEN3IA_TOOLS;

  const systemPrompt = agentContext?.charter
    ? [
        PLAN_SYSTEM,
        "",
        "AGENT PERSONNALISÉ — CHARTE OBLIGATOIRE :",
        agentContext.charter,
        "Chaque étape du plan doit respecter strictement cette charte : n'inclus AUCUNE étape qui sortirait du périmètre de l'agent. Si l'objectif sort du périmètre, produis un plan minimal d'une seule étape llm qui le signale et refuse courtoisement.",
      ].join("\n")
    : PLAN_SYSTEM;

  const buildUserPrompt = (correctiveHint?: string) =>
    [
      JSON.stringify({ objective: trimmed, availableCapabilities: toolCatalog(catalog) }),
      correctiveHint
        ? `\nIMPORTANT — ta réponse précédente a été rejetée :\n${correctiveHint}\nCorrige-la et renvoie un JSON valide avec AU MOINS UNE étape.`
        : "",
    ].join("");

  // Résilience (jamais de plan invalide au runtime) : 1) tentative initiale ;
  // 2) une tentative corrective avec l'erreur renvoyée au modèle ; 3) plan de
  // repli déterministe. `steps: []` est le cas d'échec observé en production.
  const tentatives = 2;
  let dernierErreur = "";
  for (let essai = 1; essai <= tentatives; essai++) {
    const response = await generate({
      task: "agent",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: buildUserPrompt(essai > 1 ? dernierErreur : undefined) },
      ],
      requiresStructuredOutput: true,
      preferFree: true,
      maxTokens: 6000,
      provider: options?.provider,
      model: options?.model,
      metadata: { userId },
    });

    let parsed: unknown;
    try {
      parsed = extractJsonObject(response.text);
    } catch (error) {
      dernierErreur = error instanceof Error ? error.message : "The agent planner returned invalid JSON.";
      console.warn(`[planner] Tentative ${essai}/${tentatives} échouée (JSON):`, dernierErreur);
      continue;
    }

    if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).steps)) {
      (parsed as Record<string, unknown>).steps = normalizeSteps((parsed as Record<string, unknown>).steps);
    }

    try {
      return finaliserPlan(userId, RuntimePlanSchema.parse(parsed), trimmed, allowedTools);
    } catch (error) {
      dernierErreur = error instanceof Error ? error.message : "invalid plan";
      console.warn(`[planner] Tentative ${essai}/${tentatives} échouée (plan):`, dernierErreur.slice(0, 300));
    }
  }

  // Palier final : repli déterministe — la mission reste exécutable au lieu
  // d'une erreur "Le plan généré par l'agent est incomplet".
  console.warn("[planner] Repli déterministe après échec du planificateur LLM:", dernierErreur.slice(0, 300));
  return finaliserPlan(userId, fallbackPlan(trimmed), trimmed, allowedTools);
}

/**
 * Finalise un plan validé par le schéma : dégradation résiliente des outils
 * inconnus ou hors périmètre (étape llm) puis validation du DAG par le
 * runtime. Ne jette QUE sur un vrai problème de DAG (cycle), jamais sur une
 * sortie LLM réparables — un plan invalide n'atteint jamais l'exécuteur.
 */
function finaliserPlan(userId: string, plan: RuntimePlan, objective: string, allowedTools?: string[]): RuntimePlan {
  const normalized = RuntimePlanSchema.parse({
    ...plan,
    objective,
    steps: plan.steps.slice(0, MAX_PLAN_STEPS),
    maxConcurrency: Math.min(plan.maxConcurrency ?? 4, 4),
    maxIterations: Math.min(plan.maxIterations ?? 10, 20),
  });
  for (const step of normalized.steps) {
    if (step.type === "tool" && !step.toolName) {
      // Étape tool sans cible : inutilisable, dégradée en raisonnement.
      step.type = "llm";
      step.description = `${step.description} (outil non spécifié remplacé par une analyse textuelle)`.slice(0, 600);
      continue;
    }
    if (step.type === "tool" && step.toolName && !GEN3IA_TOOLS.some((tool) => tool.name === step.toolName)) {
      // Outil inexistant au registre : dégradation plutôt qu'échec brut.
      step.type = "llm";
      step.toolName = undefined;
      step.description = `${step.description} (outil indisponible remplacé par une analyse textuelle)`.slice(0, 600);
    }
  }

  // Application de la whitelist d'outils de l'agent : une étape tool hors
  // périmètre est dégradée en étape de raisonnement (résilient) plutôt que
  // de faire échouer toute la mission.
  if (allowedTools) {
    for (const step of normalized.steps) {
      if (step.type === "tool" && step.toolName && !allowedTools.includes(step.toolName)) {
        step.type = "llm";
        step.toolName = undefined;
        step.description = `${step.description} (outil hors périmètre remplacé par une analyse textuelle)`.slice(0, 600);
      }
    }
  }

  const runtime = new AgentRuntime({
    userId,
    objective,
    plan: normalized,
    policy: DEFAULT_EXECUTION_POLICY,
  });
  // Construction validates the DAG. Execution is intentionally separate so
  // callers can inspect/approve the generated plan before side effects.
  void runtime;
  return normalized;
}
