import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { generate } from "@/lib/ai/router";
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

function toolCatalog(): string {
  return GEN3IA_TOOLS.map((tool) =>
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
    knownIds.add(base.id);
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

function normalizePlan(plan: RuntimePlan, objective: string): RuntimePlan {
  const normalized = RuntimePlanSchema.parse({
    ...plan,
    executionId: plan.executionId || randomUUID(),
    objective,
    steps: plan.steps.slice(0, MAX_PLAN_STEPS),
    maxConcurrency: Math.min(plan.maxConcurrency ?? 4, 4),
    maxIterations: Math.min(plan.maxIterations ?? 10, 20),
  });
  for (const step of normalized.steps) {
    if (step.type === "tool" && !step.toolName) throw new Error(`Tool step ${step.id} has no toolName.`);
    if (step.type === "tool" && !GEN3IA_TOOLS.some((tool) => tool.name === step.toolName)) {
      throw new Error(`Planner selected an unavailable tool: ${step.toolName}`);
    }
  }
  return normalized;
}

export async function planUniversalAgent(
  userId: string,
  objective: string,
  options?: { policy?: ExecutionPolicy; signal?: AbortSignal },
): Promise<RuntimePlan> {
  const trimmed = objective.trim();
  if (!trimmed || trimmed.length > MAX_OBJECTIVE_LENGTH) throw new Error("Invalid agent objective.");

  const response = await generate({
    task: "agent",
    messages: [
      { role: "system", content: PLAN_SYSTEM },
      { role: "user", content: JSON.stringify({ objective: trimmed, availableCapabilities: toolCatalog() }) },
    ],
    requiresStructuredOutput: true,
    preferFree: true,
    maxTokens: 6000,
    metadata: { userId },
  });

  let parsed: unknown;
  try {
    parsed = extractJsonObject(response.text);
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "The agent planner returned invalid JSON.",
    );
  }

  if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).steps)) {
    (parsed as Record<string, unknown>).steps = normalizeSteps((parsed as Record<string, unknown>).steps);
  }

  let plan: RuntimePlan;
  try {
    plan = normalizePlan(RuntimePlanSchema.parse(parsed), trimmed);
  } catch (error) {
    // Do not leak raw zod diagnostics to end users; keep the message actionable.
    if (error instanceof Error && error.message.startsWith("Tool step")) throw error;
    if (error instanceof Error && error.message.startsWith("Planner selected")) throw error;
    if (error instanceof ZodError) {
      console.error("[planner] invalid plan issues:", JSON.stringify(error.issues).slice(0, 1200));
    }
    throw new Error("Le plan généré par l'agent est incomplet. Reformulez votre demande ou réessayez.");
  }
  const runtime = new AgentRuntime({
    userId,
    objective: trimmed,
    plan,
    policy: options?.policy ?? DEFAULT_EXECUTION_POLICY,
    signal: options?.signal,
  });
  // Construction validates the DAG. Execution is intentionally separate so
  // callers can inspect/approve the generated plan before side effects.
  void runtime;
  return plan;
}
