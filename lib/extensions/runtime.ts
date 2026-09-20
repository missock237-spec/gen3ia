import type { ExtensionManifest } from "./manifest";
import { buildExtensionRequest, readExtensionResponse, renderStepInput } from "./http-template";
import { validateSimpleRecord } from "./schema-validate";
import { rateLimit } from "@/lib/security/rate-limit";
import { dailyExecutionLimit, pricingFromManifest, type PricingInfo } from "./pricing";
import { reserveFunds, settleReservation, releaseReservation } from "@/lib/billing/wallet";
import type { InstallationDoc } from "./repository";
import {
  consumeExecutionQuota,
  getEntitlement,
  getExtension,
  getExtensionSecrets,
  getInstallation,
  getLatestApprovedVersion,
  getVersion,
  recordExtensionExecution,
} from "./repository";
import { canUseExtension } from "./pricing";

/**
 * Gen3ia Extension Runtime — sandboxed execution pipeline.
 *
 * Architecture (defense in depth):
 *
 *   Extension tool call
 *     -> installation check (active, version pinned)
 *     -> entitlement check (paid models)
 *     -> rate limit (per user + extension, in-process sliding window)
 *     -> daily quota (Firestore counter per user/extension/day)
 *     -> usage-based wallet charge (when pricing.model = usage)
 *     -> input validation (manifest-declared SimpleField schemas)
 *     -> permission engine (http.fetch host must be granted AND declared)
 *     -> server-side secret injection (values never leave the server)
 *     -> outbound HTTPS with timeout + SSRF guards (no private hosts)
 *     -> output validation + size cap
 *     -> execution audit log (extensionExecutions)
 *
 * No third-party code ever executes in-process. The manifest's declarative
 * connector model is designed so a future isolated container runtime can be
 * plugged in behind `executeExtensionTool` without changing callers.
 */

export const EXTENSION_TOOL_PREFIX = "ext.";
const DEFAULT_RATE_PER_MIN = Number(process.env.EXTENSION_RATE_LIMIT_PER_MIN ?? 30);

export interface ExtensionToolName {
  extensionId: string;
  toolId: string;
}

/** Tool naming convention: `ext.<extensionId>.<toolId>`. */
export function parseExtensionToolName(toolName: string): ExtensionToolName | null {
  if (!toolName.startsWith(EXTENSION_TOOL_PREFIX)) return null;
  const parts = toolName.slice(EXTENSION_TOOL_PREFIX.length).split(".");
  if (parts.length < 2) return null;
  const [extensionId, ...rest] = parts;
  const toolId = rest.join(".");
  if (!extensionId || !toolId) return null;
  return { extensionId, toolId };
}

export function extensionToolName(extensionId: string, toolId: string): string {
  return `${EXTENSION_TOOL_PREFIX}${extensionId}.${toolId}`;
}

export interface ExecuteExtensionToolOptions {
  userId: string;
  toolName: string;
  input: Record<string, unknown>;
  executionId?: string;
  signal?: AbortSignal;
  /** Project context is required for developer-owned runtime calls. */
  projectId?: string;
}

interface ResolvedTool {
  manifest: ExtensionManifest;
  tool: NonNullable<ExtensionManifest["tools"]>[number];
  installation: InstallationDoc;
  version: string;
}

async function resolveTool(extensionId: string, toolId: string, userId: string): Promise<ResolvedTool> {
  const installation = await getInstallation(extensionId, userId);
  if (!installation || installation.status !== "active") {
    throw new Error("Extension not installed or disabled for this user.");
  }
  const extension = await getExtension(extensionId);
  if (!extension) throw new Error("Extension not found.");
  if (extension.status !== "approved") throw new Error("Extension is not currently available.");
  const version = await getVersion(extensionId, installation.version);
  if (!version || version.status !== "approved") throw new Error("Installed extension version is not available.");
  const tool = (version.manifest.tools ?? []).find((item) => item.id === toolId);
  if (!tool) throw new Error(`Tool ${toolId} does not exist in extension ${extensionId}.`);
  return { manifest: version.manifest, tool, installation, version: installation.version };
}

/**
 * Executes a declarative extension tool through the full security pipeline.
 * Designed to be called from the secure tool executor so agents and direct
 * API runs get identical guarantees.
 */
export async function executeExtensionTool(options: ExecuteExtensionToolOptions): Promise<unknown> {
  const parsed = parseExtensionToolName(options.toolName);
  if (!parsed) throw new Error(`Invalid extension tool name: ${options.toolName}`);
  const { extensionId, toolId } = parsed;
  const startedAt = Date.now();

  const resolved = await resolveTool(extensionId, toolId, options.userId);
  if (options.projectId && (await getExtension(extensionId))?.projectId !== options.projectId) {
    throw new Error("Extension is not linked to this Gen3ia project.");
  }

  // 1) Entitlement (paid models).
  const pricing = pricingFromManifest(resolved.manifest) as PricingInfo;
  const entitlement = await getEntitlement(extensionId, options.userId);
  const access = canUseExtension(pricing, entitlement);
  if (!access.allowed) throw new Error(access.reason ?? "Extension access denied.");

  // 2) Rate limit + daily quota.
  const rate = rateLimit(`ext:${options.userId}:${extensionId}`, { limit: DEFAULT_RATE_PER_MIN, windowMs: 60_000 });
  if (!rate.allowed) {
    throw new Error(`Extension rate limit exceeded. Retry in ${Math.ceil(rate.retryAfterMs / 1000)}s.`);
  }
  await consumeExecutionQuota({
    userId: options.userId,
    extensionId,
    maxPerDay: dailyExecutionLimit(pricing),
  });

  // 3) Usage-based charge (reserve -> settle, released on failure).
  let usageReference: string | null = null;
  let usageReservedMinor = 0;
  if (pricing.model === "usage" && pricing.unitAmountMinor) {
    usageReference = `ext_usage_${options.userId}_${extensionId}_${startedAt}`;
    usageReservedMinor = pricing.unitAmountMinor;
    await reserveFunds({
      userId: options.userId,
      amountMinor: usageReservedMinor,
      reference: usageReference,
      metadata: { kind: "extension_usage", extensionId, toolId },
    });
  }

  try {
    // 4) Input validation against the manifest schema.
    const inputErrors = validateSimpleRecord(options.input, resolved.tool.inputSchema, "input");
    if (inputErrors.length > 0) throw new Error(`Invalid extension tool input: ${inputErrors.join(" ")}`);

    // 5) Build the outbound request (permission engine + SSRF guards + secrets).
    const secrets = await getExtensionSecrets(extensionId);
    const settings = { ...settingsFromManifest(resolved.manifest), ...resolved.installation.settings };
    const request = buildExtensionRequest(
      toolId,
      resolved.tool.endpoint,
      resolved.manifest.permissions,
      resolved.installation.permissionsGranted,
      { input: options.input, secrets, settings },
    );

    // 6) Outbound call with hard timeout.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
        cache: "no-store",
      });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }

    // 7) Output read + validation.
    const output = await readExtensionResponse(toolId, response);
    const outputErrors = validateSimpleRecord(output, resolved.tool.outputSchema, "output");
    if (outputErrors.length > 0) {
      throw new Error(`Extension tool ${toolId}: endpoint output rejected (${outputErrors.join(" ")})`);
    }

    await recordExtensionExecution({
      extensionId,
      version: resolved.version,
      userId: options.userId,
      toolId,
      ok: true,
      status: "success",
      durationMs: Date.now() - startedAt,
      executionId: options.executionId,
    });

    if (usageReference) {
      await settleReservation({
        userId: options.userId,
        reference: usageReference,
        reservedMinor: usageReservedMinor,
        actualChargeMinor: usageReservedMinor,
        metadata: { kind: "extension_usage", extensionId, toolId },
      }).catch(() => undefined);
    }
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extension execution failed.";
    const aborted = message.includes("abort") || options.signal?.aborted === true;
    await recordExtensionExecution({
      extensionId,
      version: resolved.version,
      userId: options.userId,
      toolId,
      ok: false,
      status: aborted ? "timeout" : "failed",
      durationMs: Date.now() - startedAt,
      error: message,
      executionId: options.executionId,
    }).catch(() => undefined);
    if (usageReference) {
      await releaseReservation({
        userId: options.userId,
        reference: usageReference,
        reservedMinor: usageReservedMinor,
      }).catch(() => undefined);
    }
    throw error;
  }
}

function settingsFromManifest(manifest: ExtensionManifest): Record<string, string | number | boolean> {
  const settings: Record<string, string | number | boolean> = {};
  for (const setting of manifest.settings ?? []) settings[setting.key] = setting.default;
  return settings;
}

/**
 * Runs a declared workflow: sequential extension-tool steps whose inputs may
 * reference `{{input.*}}` from the workflow input and previous step outputs.
 */
export async function runExtensionWorkflow(params: {
  userId: string;
  extensionId: string;
  workflowId: string;
  input: Record<string, unknown>;
  executionId?: string;
  signal?: AbortSignal;
  projectId?: string;
}): Promise<Array<{ toolId: string; output: unknown }>> {
  const installation = await getInstallation(params.extensionId, params.userId);
  if (!installation || installation.status !== "active") {
    throw new Error("Extension not installed or disabled for this user.");
  }
  const version = await getVersion(params.extensionId, installation.version);
  if (!version || version.status !== "approved") throw new Error("Installed extension version is not available.");
  const workflow = (version.manifest.workflows ?? []).find((item) => item.id === params.workflowId);
  if (!workflow) throw new Error(`Workflow ${params.workflowId} does not exist in extension ${params.extensionId}.`);

  const inputErrors = validateSimpleRecord(params.input, workflow.inputSchema, "input");
  if (inputErrors.length > 0) throw new Error(`Invalid workflow input: ${inputErrors.join(" ")}`);

  const outputs: Array<{ toolId: string; output: unknown }> = [];
  const accumulated: Record<string, unknown> = { ...params.input };
  for (const [index, step] of workflow.steps.entries()) {
    const stepInput = renderStepInput(step.input, { input: accumulated });
    const output = await executeExtensionTool({
      userId: params.userId,
      toolName: extensionToolName(params.extensionId, step.toolId),
      input: stepInput,
      executionId: params.executionId,
      signal: params.signal,
      projectId: params.projectId,
    });
    outputs.push({ toolId: step.toolId, output });
    accumulated[`step${index + 1}`] = output;
  }
  return outputs;
}
