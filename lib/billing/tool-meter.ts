import { estimateExecutionCost } from "./cost-engine";
import { getWallet, reserveFunds, settleReservation, releaseReservation } from "./wallet";
export type BillingMeterCategory = "web" | "browser" | "composio" | "code" | "storage" | "database" | "document" | "image" | "video" | "audio" | "voice" | "embedding" | "other";
export interface ToolMeterInput { userId: string; executionId: string; toolName: string; input: Record<string, unknown>; durationMs?: number; }
function env(name: string, fallback: number): number { const value = Number(process.env[name]); return Number.isFinite(value) && value >= 0 ? value : fallback; }
function categoryForTool(toolName: string): BillingMeterCategory { const n = toolName.toLowerCase(); if (n === "phone.call") return "voice"; if (n.includes("web.search") || n.includes("search")) return "web"; if (n.includes("browser") || n.includes("playwright") || n.includes("computer")) return "browser"; if (n.includes("composio")) return "composio"; if (n.includes("code.execute") || n.includes("sandbox") || n.includes("terminal")) return "code"; if (n.includes("image") || n.includes("vision")) return "image"; if (n.includes("video")) return "video"; if (n.includes("voice") || n.includes("speech")) return "voice"; if (n.includes("audio") || n.includes("tts") || n.includes("transcrib")) return "audio"; if (n.includes("embed")) return "embedding"; if (n.includes("zip") || n.includes("file") || n.includes("artifact") || n.includes("storage")) return "storage"; if (n.includes("document") || n.includes("pdf")) return "document"; if (n.includes("database") || n.includes("sql")) return "database"; return "other"; }
function externalCost(category: BillingMeterCategory, input: Record<string, unknown>, toolName?: string): number {
  const explicit = Number(input.externalCostEur);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const defaults: Record<BillingMeterCategory, number> = {
    web: env("COST_WEB_SEARCH_EUR", 0.002),
    browser: env("COST_BROWSER_ACTION_EUR", 0.004),
    composio: env("COST_COMPOSIO_ACTION_EUR", 0.003),
    code: env("COST_SANDBOX_EUR_PER_MINUTE", 0.01),
    storage: 0,
    database: env("COST_DATABASE_OPERATION_EUR", 0.0002),
    document: env("COST_DOCUMENT_OPERATION_EUR", 0.001),
    image: env("COST_IMAGE_TOOL_OVERHEAD_EUR", 0.005),
    video: env("COST_VIDEO_TOOL_OVERHEAD_EUR", 0.02),
    audio: env("COST_AUDIO_TOOL_OVERHEAD_EUR", 0.005),
    voice: env("COST_VOICE_TOOL_OVERHEAD_EUR", 0.01),
    embedding: env("COST_EMBEDDING_TOOL_OVERHEAD_EUR", 0.001),
    other: env("COST_OTHER_TOOL_EUR", 0.0005),
  };
  if (toolName === "phone.call") {
    const seconds = Math.max(30, Math.min(900, Number(input.maxDurationSeconds ?? 300)));
    return env("COST_VOICE_CALL_EUR_PER_MINUTE", 0.12) * (seconds / 60);
  }
  if (category === "code") return defaults.code * Math.max(1, Number(input.durationMs ?? 0) / 60_000);
  return defaults[category];
}
export function estimateToolCharge(input: ToolMeterInput) { const category = categoryForTool(input.toolName); const complexity = Number(input.input.complexity ?? 1); const task = category === "image" ? "image" : category === "video" ? "video" : category === "audio" || category === "voice" ? "audio" : category === "document" ? "document" : category === "web" ? "research" : "automation"; return { category, ...estimateExecutionCost({ task, inputTokens: 0, outputTokens: 0, storageBytes: Math.max(0, Number(input.input.storageBytes ?? input.input.bytes ?? 0)), networkBytes: Math.max(0, Number(input.input.networkBytes ?? 0)), externalToolCostEur: externalCost(category, { ...input.input, durationMs: input.durationMs }, input.toolName), toolCalls: 1, complexity: Math.max(0.5, Math.min(5, Number.isFinite(complexity) ? complexity : 1)) }) }; }
export async function reserveToolExecution(input: ToolMeterInput) { const estimate = estimateToolCharge(input); const reference = `tool_${input.executionId}_${crypto.randomUUID()}`; // Garde-fou : Math.max(1, NaN) === NaN — une estimation non finie retombe sur 100 minor (1 EUR).
const reserveMinor = Number.isFinite(estimate.reserveMinor) && estimate.reserveMinor >= 1 ? Math.ceil(estimate.reserveMinor) : 100; const maxReserveMinor = Math.max(1, Math.floor(env("GEN3IA_MAX_TOOL_RESERVE_EUR", 5) * 100)); if (reserveMinor > maxReserveMinor) throw new Error(`Tool execution exceeds the maximum autonomous spend limit of ${maxReserveMinor / 100} EUR.`); const wallet = await getWallet(input.userId); if (wallet.availableMinor < reserveMinor) throw new Error("Insufficient wallet balance for tool execution."); await reserveFunds({ userId: input.userId, amountMinor: reserveMinor, reference, metadata: { toolName: input.toolName, category: estimate.category } }); return { reference, reserveMinor, estimate }; }
export async function settleToolExecution(input: { userId: string; toolName: string; input: Record<string, unknown>; durationMs: number; reference: string; reserveMinor: number }) { const actual = estimateToolCharge({ userId: input.userId, executionId: input.reference, toolName: input.toolName, input: { ...input.input, durationMs: input.durationMs }, durationMs: input.durationMs }); const chargeMinor = Math.max(0, actual.chargeMinor); const maxReserveMinor = Math.max(1, Math.floor(env("GEN3IA_MAX_TOOL_RESERVE_EUR", 5) * 100)); if (chargeMinor > maxReserveMinor) throw new Error("Actual execution cost exceeds the autonomous spend limit."); await settleReservation({ userId: input.userId, reference: input.reference, reservedMinor: input.reserveMinor, actualChargeMinor: chargeMinor, metadata: { toolName: input.toolName, category: actual.category, durationMs: String(input.durationMs) } }); return { ...actual, chargeMinor }; }
export function releaseToolExecution(input: { userId: string; reference: string; reserveMinor: number }) { return releaseReservation({ userId: input.userId, reference: input.reference, reservedMinor: input.reserveMinor }); }
