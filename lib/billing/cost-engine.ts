import type { AIProvider, AIResponse, AIRequest, TaskType } from "@/lib/ai/models";

const n = (value: string | undefined, fallback: number) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback; };
const DEFAULT_INPUT_PER_MILLION: Record<AIProvider, number> = { openai: n(process.env.COST_OPENAI_INPUT_EUR_PER_1M, 2.5), anthropic: n(process.env.COST_ANTHROPIC_INPUT_EUR_PER_1M, 3), groq: n(process.env.COST_GROQ_INPUT_EUR_PER_1M, 0.6), openrouter: n(process.env.COST_OPENROUTER_INPUT_EUR_PER_1M, 1.5), glm: n(process.env.COST_GLM_INPUT_EUR_PER_1M, 1), agnes: n(process.env.COST_AGNES_INPUT_EUR_PER_1M, 0.5), huggingface: n(process.env.COST_HF_INPUT_EUR_PER_1M, 0.8) };
const DEFAULT_OUTPUT_PER_MILLION: Record<AIProvider, number> = { openai: n(process.env.COST_OPENAI_OUTPUT_EUR_PER_1M, 10), anthropic: n(process.env.COST_ANTHROPIC_OUTPUT_EUR_PER_1M, 15), groq: n(process.env.COST_GROQ_OUTPUT_EUR_PER_1M, 0.8), openrouter: n(process.env.COST_OPENROUTER_OUTPUT_EUR_PER_1M, 5), glm: n(process.env.COST_GLM_OUTPUT_EUR_PER_1M, 3), agnes: n(process.env.COST_AGNES_OUTPUT_EUR_PER_1M, 1.5), huggingface: n(process.env.COST_HF_OUTPUT_EUR_PER_1M, 3) };
const TASK_MULTIPLIER: Record<TaskType, number> = { chat: 1, reasoning: 1.5, research: 1.25, coding: 1.35, image: 1.5, video: 2.5, audio: 1.8, document: 1.1, automation: 1.25, agent: 1.4 };
const PLATFORM_OVERHEAD_EUR = n(process.env.GEN3IA_EXECUTION_OVERHEAD_EUR, 0.0005);
const PLATFORM_MARGIN = Math.max(0, n(process.env.GEN3IA_PLATFORM_MARGIN_RATE, 0.35));
const RESERVE_MULTIPLIER = Math.max(1, n(process.env.GEN3IA_RESERVE_MULTIPLIER, 2));
const MIN_CHARGE_EUR = Math.max(0, n(process.env.GEN3IA_MIN_EXECUTION_CHARGE_EUR, 0.001));

interface ModelRate { provider: AIProvider; model: string; inputEurPer1M: number; outputEurPer1M: number; cachedInputEurPer1M?: number; reasoningOutputEurPer1M?: number; }
function modelRates(): ModelRate[] { try { const parsed = JSON.parse(process.env.GEN3IA_MODEL_PRICING_JSON ?? "[]"); return Array.isArray(parsed) ? parsed.filter((x): x is ModelRate => x && typeof x.provider === "string" && typeof x.model === "string" && Number.isFinite(Number(x.inputEurPer1M)) && Number.isFinite(Number(x.outputEurPer1M))) : []; } catch { return []; } }
function rateFor(provider: AIProvider, model?: string): ModelRate { const match = modelRates().find((x) => x.provider === provider && (!model || x.model === model)); const fallback: ModelRate = { provider, model: model ?? "auto", inputEurPer1M: DEFAULT_INPUT_PER_MILLION[provider], outputEurPer1M: DEFAULT_OUTPUT_PER_MILLION[provider] };
  if (!match) return fallback;
  // Les tarifs venant de l'environnement peuvent etre incomplets : on retombe
  // sur les tarifs par defaut pour toute valeur non finie (evite NaN/Infinity
  // dans le calcul de reservation du portefeuille).
  const input = Number(match.inputEurPer1M); const output = Number(match.outputEurPer1M);
  if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) return fallback;
  return { ...match, inputEurPer1M: input, outputEurPer1M: output };
}
function clampComplexity(value: number | undefined): number { const parsed = Number(value); if (!Number.isFinite(parsed)) return 1; return Math.min(5, Math.max(0.5, parsed)); }
function ceilMinor(eur: number): number { if (!Number.isFinite(eur)) return 0; return Math.max(0, Math.ceil(eur * 100)); }

export interface ExecutionCostInput { task: TaskType; provider?: AIProvider; model?: string; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number; durationMs?: number; storageBytes?: number; networkBytes?: number; computeUnits?: number; externalToolCostEur?: number; toolCalls?: number; complexity?: number; }
export interface ExecutionCostBreakdown { providerCostEur: number; platformOverheadEur: number; computeCostEur: number; storageCostEur: number; networkCostEur: number; externalToolCostEur: number; complexityMultiplier: number; marginEur: number; chargeEur: number; reserveEur: number; chargeMinor: number; reserveMinor: number; }

export function estimateExecutionCost(input: ExecutionCostInput): ExecutionCostBreakdown {
  const provider = input.provider ?? "openrouter"; const rate = rateFor(provider, input.model);
  const inputTokens = Math.max(0, input.inputTokens ?? 0); const outputTokens = Math.max(0, input.outputTokens ?? 0); const cached = Math.min(inputTokens, Math.max(0, input.cachedInputTokens ?? 0));
  const normalInput = inputTokens - cached;
  const inputCost = normalInput / 1_000_000 * rate.inputEurPer1M + cached / 1_000_000 * (rate.cachedInputEurPer1M ?? rate.inputEurPer1M) + outputTokens / 1_000_000 * rate.outputEurPer1M;
  const reasoningCost = Math.max(0, input.reasoningTokens ?? 0) / 1_000_000 * (rate.reasoningOutputEurPer1M ?? rate.outputEurPer1M);
  const toolOverhead = Math.max(0, input.toolCalls ?? 0) * n(process.env.GEN3IA_TOOL_CALL_OVERHEAD_EUR, 0.0002);
  const computeCostEur = Math.max(0, input.computeUnits ?? 0) * n(process.env.GEN3IA_COMPUTE_EUR_PER_UNIT, 0.001);
  const storageCostEur = Math.max(0, input.storageBytes ?? 0) / (1024 ** 3) * n(process.env.GEN3IA_STORAGE_EUR_PER_GB, 0.02);
  const networkCostEur = Math.max(0, input.networkBytes ?? 0) / (1024 ** 3) * n(process.env.GEN3IA_NETWORK_EUR_PER_GB, 0.08);
  const providerCostEur = inputCost + reasoningCost + toolOverhead;
  const complexityMultiplier = clampComplexity(input.complexity) * (TASK_MULTIPLIER[input.task] ?? 1);
  const rawCost = (providerCostEur + PLATFORM_OVERHEAD_EUR + computeCostEur + storageCostEur + networkCostEur + Math.max(0, input.externalToolCostEur ?? 0)) * complexityMultiplier;
  const marginEur = rawCost * PLATFORM_MARGIN; const chargeEur = Math.max(MIN_CHARGE_EUR, rawCost + marginEur); const reserveEur = Math.max(chargeEur, chargeEur * RESERVE_MULTIPLIER);
  return { providerCostEur, platformOverheadEur: PLATFORM_OVERHEAD_EUR, computeCostEur, storageCostEur, networkCostEur, externalToolCostEur: Math.max(0, input.externalToolCostEur ?? 0), complexityMultiplier, marginEur, chargeEur, reserveEur, chargeMinor: ceilMinor(chargeEur), reserveMinor: ceilMinor(reserveEur) };
}
export function costFromAIResponse(request: AIRequest, response: AIResponse): ExecutionCostBreakdown { return estimateExecutionCost({ task: request.task, provider: response.provider, model: response.model, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, durationMs: response.latencyMs, complexity: request.requiresTools ? 1.15 : 1, toolCalls: request.requiresTools ? 1 : 0 }); }
