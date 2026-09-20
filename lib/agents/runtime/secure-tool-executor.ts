import { executeTool } from "@/lib/tools";
import { ExecutionPolicy, DEFAULT_EXECUTION_POLICY } from "@/lib/security/execution-policy";
import { authorizeTool } from "@/lib/security/tool-permissions";
import { assertSafeToolInput, assertSafeToolOutput } from "@/lib/security/guardrails";
import { assertAutonomousActionAllowed } from "@/lib/security/autonomy-guard";
import { assertExecutionNotStopped } from "@/lib/security/emergency-stop";
import { appendSecurityAuditEvent } from "@/lib/security/security-audit";
import { claimExecutionIdempotency, completeExecutionIdempotency, failExecutionIdempotency } from "@/lib/security/execution-idempotency";
import { assertExecutionInputSize, assertOutputSize } from "./execution-limits";
import { executeSandbox } from "@/lib/sandbox/client";
import type { SandboxRuntime, SandboxLimits } from "@/lib/sandbox/types";
import { executeAgentTerminal } from "./agent-terminal";
import { recall, remember } from "@/lib/memory/user-memory";
import { requestCameraCapture } from "@/lib/camera/agent-camera";
import { executeAdsTool, type AdsProvider } from "@/lib/integrations/composio/ads";
import { assertAdsSpendPolicy } from "@/lib/security/ads-spend-guard";
import { commitAdsDailySpend, releaseAdsDailySpend, reserveAdsDailySpend, type AdsSpendReservation } from "@/lib/security/ads-spend-budget";
import { reserveToolExecution, settleToolExecution, releaseToolExecution } from "@/lib/billing/tool-meter";
import { executeExtensionTool } from "@/lib/extensions/runtime";
import { isExtensionToolName } from "@/lib/security/tool-permissions";

export interface SecureToolExecutionOptions {
  userId: string;
  projectId?: string;
  executionId: string;
  agentId?: string;
  toolName: string;
  input: Record<string, unknown>;
  policy?: ExecutionPolicy;
  signal?: AbortSignal;
  approvalId?: string;
}

const DEFAULT_SANDBOX_LIMITS: SandboxLimits = { timeoutMs: 30_000, memoryMb: 512, cpu: 1, maxOutputBytes: 1_000_000 };
const ADS_TOOL_PREFIXES = [/^GOOGLEADS_/i, /^METAADS_/i, /^TIKTOK_ADS_/i];

function isAdsComposioTool(input: Record<string, unknown>): boolean {
  return typeof input.toolSlug === "string" && ADS_TOOL_PREFIXES.some((prefix) => prefix.test(input.toolSlug as string));
}

function parseSandboxInput(input: Record<string, unknown>) {
  const runtime = input.runtime;
  const code = input.code;
  const providedLimits = input.limits;
  if (runtime !== "node" && runtime !== "python") throw new Error("code.execute requires runtime 'node' or 'python'");
  if (typeof code !== "string" || code.length === 0 || code.length > 500_000) throw new Error("code.execute requires code between 1 and 500000 characters");
  if (providedLimits !== undefined && (typeof providedLimits !== "object" || providedLimits === null)) throw new Error("code.execute limits must be an object");
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...(providedLimits as Partial<SandboxLimits> | undefined) };
  if (!Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 100 || limits.timeoutMs > 120_000 || !Number.isInteger(limits.memoryMb) || limits.memoryMb < 64 || limits.memoryMb > 2_048 || typeof limits.cpu !== "number" || limits.cpu < 0.1 || limits.cpu > 2 || !Number.isInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1_024 || limits.maxOutputBytes > 10_000_000) throw new Error("code.execute limits are outside the allowed sandbox bounds");
  return { runtime: runtime as SandboxRuntime, code, input: input.input, limits };
}

function parseAdsExecutionInput(input: Record<string, unknown>) {
  const provider = input.provider;
  const toolSlug = input.toolSlug;
  const accountId = input.accountId;
  const args = input.arguments;
  if (provider !== "google_ads" && provider !== "meta_ads" && provider !== "tiktok_ads") throw new Error("Ads execution requires a supported Ads provider.");
  if (typeof toolSlug !== "string" || toolSlug.length > 200) throw new Error("Ads execution requires a Composio toolSlug.");
  if (typeof accountId !== "string" || !accountId.trim() || accountId.length > 256) throw new Error("Ads execution requires an explicit connected account ID.");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Ads execution requires an arguments object.");
  assertAdsSpendPolicy(input);
  return {
    provider: provider as AdsProvider,
    toolSlug,
    connectedAccountId: accountId,
    arguments: args as Record<string, unknown>,
    maxAdSpendMinor: input.maxAdSpendMinor as number,
    requestedDailyLimitMinor: typeof input.dailyAdSpendLimitMinor === "number" ? input.dailyAdSpendLimitMinor : undefined,
  };
}

export async function executeToolSecurely(options: SecureToolExecutionOptions): Promise<unknown> {
  const policy = options.policy ?? DEFAULT_EXECUTION_POLICY;
  assertExecutionInputSize(options.input, policy.maxInputBytes);
  const definition = authorizeTool(policy, options.toolName);
  assertSafeToolInput(options.input);
  await assertAutonomousActionAllowed({ userId: options.userId, toolName: options.toolName, input: options.input, approvalId: options.approvalId });
  await assertExecutionNotStopped({ userId: options.userId, executionId: options.executionId, agentId: options.agentId ?? (typeof options.input.agentId === "string" ? options.input.agentId : undefined) });
  await appendSecurityAuditEvent({ userId: options.userId, executionId: options.executionId, toolName: options.toolName, event: "authorized", risk: definition.risk, approvalId: options.approvalId });
  if (options.signal?.aborted) throw new Error("Execution cancelled");

  const idempotencyRequired = definition.risk === "external" || definition.risk === "destructive";
  let idempotencyKey: string | undefined;
  if (idempotencyRequired) {
    const claim = await claimExecutionIdempotency({ userId: options.userId, toolName: options.toolName, key: options.approvalId ?? options.executionId, input: options.input });
    idempotencyKey = claim.key;
    if (claim.state === "completed") return claim.result;
    if (claim.state === "failed") throw new Error(claim.error ?? "This action was already finalized as failed and cannot be replayed.");
  }

  const startedAt = Date.now();
  const reservation = await reserveToolExecution({ userId: options.userId, executionId: options.executionId, toolName: options.toolName, input: { ...options.input, risk: definition.risk } });
  let executionStarted = false;
  let settlementAttempted = false;
  let adsReservation: (AdsSpendReservation & { userId: string; provider: AdsProvider; accountId: string }) | undefined;
  let adsSpendCommitted = false;

  try {
    await assertExecutionNotStopped({ userId: options.userId, executionId: options.executionId, agentId: options.agentId ?? (typeof options.input.agentId === "string" ? options.input.agentId : undefined) });
    await appendSecurityAuditEvent({ userId: options.userId, executionId: options.executionId, toolName: options.toolName, event: "started", risk: definition.risk, approvalId: options.approvalId });
    executionStarted = true;

    const adsInput = (options.toolName === "ads.publish" || (options.toolName === "composio.execute" && isAdsComposioTool(options.input))) ? parseAdsExecutionInput(options.input) : undefined;
    if (adsInput) {
      const budget = await reserveAdsDailySpend({ userId: options.userId, provider: adsInput.provider, accountId: adsInput.connectedAccountId, amountMinor: adsInput.maxAdSpendMinor, requestedDailyLimitMinor: adsInput.requestedDailyLimitMinor });
      adsReservation = { ...budget, userId: options.userId, provider: adsInput.provider, accountId: adsInput.connectedAccountId };
      await appendSecurityAuditEvent({ userId: options.userId, executionId: options.executionId, toolName: options.toolName, event: "ads_spend_reserved", risk: definition.risk, approvalId: options.approvalId, result: { provider: adsInput.provider, accountId: adsInput.connectedAccountId, amountMinor: adsInput.maxAdSpendMinor, dailyLimitMinor: budget.dailyLimitMinor } }).catch(() => undefined);
    }

    let result: unknown;
    if (adsInput) {
      result = await executeAdsTool({ userId: options.userId, provider: adsInput.provider, toolSlug: adsInput.toolSlug, connectedAccountId: adsInput.connectedAccountId, arguments: adsInput.arguments, signal: options.signal });
    } else if (options.toolName === "terminal.execute") {
      const runtime = options.input.runtime === "python" ? "python" : "node";
      if (typeof options.input.command !== "string") throw new Error("terminal.execute requires command");
      result = await executeAgentTerminal({ userId: options.userId, executionId: options.executionId, runtime, command: options.input.command, cwd: typeof options.input.cwd === "string" ? options.input.cwd : undefined, timeoutMs: typeof options.input.timeoutMs === "number" ? options.input.timeoutMs : undefined, memoryMb: typeof options.input.memoryMb === "number" ? options.input.memoryMb : undefined });
    } else if (options.toolName === "memory.read") {
      if (typeof options.input.key !== "string") throw new Error("memory.read requires key");
      result = await recall({ userId: options.userId, key: options.input.key });
    } else if (options.toolName === "memory.write") {
      if (typeof options.input.key !== "string") throw new Error("memory.write requires key");
      await remember({ userId: options.userId, key: options.input.key, value: options.input.value, source: "agent" });
      result = { ok: true };
    } else if (options.toolName === "camera.capture") {
      if (typeof options.input.reason !== "string") throw new Error("camera.capture requires reason");
      result = await requestCameraCapture({ userId: options.userId, executionId: options.executionId, agentId: typeof options.input.agentId === "string" ? options.input.agentId : undefined, reason: options.input.reason, facingMode: options.input.facingMode === "user" ? "user" : "environment" });
    } else if (options.toolName === "code.execute") {
      const sandbox = parseSandboxInput(options.input);
      result = await executeSandbox({ executionId: options.executionId, userId: options.userId, runtime: sandbox.runtime, code: sandbox.code, input: sandbox.input, limits: sandbox.limits, network: "none" });
    } else if (isExtensionToolName(options.toolName)) {
      // Declarative extension tool: runs through the Extension Runtime
 // pipeline (entitlement, quotas, rate limit, permission engine, SSRF
 // guards, timeouts, secrets injection, output validation, audit logs).
      result = await executeExtensionTool({ userId: options.userId, executionId: options.executionId, toolName: options.toolName, input: options.input, signal: options.signal });
    } else {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), policy.maxToolExecutionMs);
      const onAbort = () => controller.abort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const toolResult = await executeTool({ userId: options.userId, executionId: options.executionId, toolName: options.toolName, input: options.input, signal: controller.signal, policy, projectId: options.projectId });
        if (!toolResult.success) throw new Error(toolResult.error ?? `Tool ${options.toolName} failed`);
        result = toolResult.output;
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      }
    }

    await assertExecutionNotStopped({ userId: options.userId, executionId: options.executionId, agentId: options.agentId ?? (typeof options.input.agentId === "string" ? options.input.agentId : undefined) });
    assertOutputSize(result, policy.maxOutputBytes);
    assertSafeToolOutput(result);

    if (adsReservation) {
      await commitAdsDailySpend(adsReservation);
      adsSpendCommitted = true;
      await appendSecurityAuditEvent({ userId: options.userId, executionId: options.executionId, toolName: options.toolName, event: "ads_spend_committed", risk: definition.risk, approvalId: options.approvalId, result: { amountMinor: adsReservation.amountMinor, provider: adsReservation.provider, accountId: adsReservation.accountId } }).catch(() => undefined);
    }

    settlementAttempted = true;
    try {
      await settleToolExecution({ userId: options.userId, toolName: options.toolName, input: options.input, durationMs: Date.now() - startedAt, reference: reservation.reference, reserveMinor: reservation.reserveMinor });
    } catch (billingError) {
      await appendSecurityAuditEvent({ userId: options.userId, executionId: options.executionId, toolName: options.toolName, event: "billing_failed", risk: definition.risk, approvalId: options.approvalId, error: billingError instanceof Error ? billingError.message : "Billing settlement failed" }).catch(() => undefined);
      throw billingError;
    }
    await appendSecurityAuditEvent({ userId: options.userId, executionId: options.executionId, toolName: options.toolName, event: "completed", risk: definition.risk, approvalId: options.approvalId, result: { success: true } }).catch(() => undefined);
    if (idempotencyKey) await completeExecutionIdempotency({ key: idempotencyKey, result });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed.";
    const stopped = message.includes("emergency stop");
    await appendSecurityAuditEvent({ userId: options.userId, executionId: options.executionId, toolName: options.toolName, event: stopped ? "stopped" : "failed", risk: definition.risk, approvalId: options.approvalId, error: message }).catch(() => undefined);
    if (idempotencyKey) await failExecutionIdempotency({ key: idempotencyKey, error: message }).catch(() => undefined);
    if (adsReservation && !adsSpendCommitted) await releaseAdsDailySpend(adsReservation).catch(() => undefined);
    const ambiguousSideEffect = executionStarted && (definition.risk === "external" || definition.risk === "destructive");
    if (!ambiguousSideEffect && !settlementAttempted) {
      await releaseToolExecution({ userId: options.userId, reference: reservation.reference, reserveMinor: reservation.reserveMinor }).catch(() => undefined);
    }
    throw error;
  }
}
