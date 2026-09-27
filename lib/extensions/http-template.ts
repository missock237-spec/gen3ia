import { assertPermissionsGranted, isPrivateHost } from "./permissions";

/**
 * Safe request builder for declarative extension tools (pure).
 *
 * - URL templates only interpolate `{{input.field}}` (URI-encoded).
 * - Secrets are only interpolated in header values / body (never in URLs).
 * - The target host must be public and covered by an http.fetch permission.
 * - The rendered body must be valid JSON when a bodyTemplate is declared.
 */

const TEMPLATE_REF = /\{\{\s*(input|secret|setting)\.([a-zA-Z0-9_.-]+)\s*\}\}/g;
const MAX_OUTPUT_CHARS = 512_000;

export interface ToolEndpoint {
  method: string;
  url: string;
  headers?: Array<{ name: string; value: string }>;
  bodyTemplate?: string;
  timeoutMs?: number;
}

export interface RenderContext {
  input: Record<string, unknown>;
  secrets?: Record<string, string>;
  settings?: Record<string, string | number | boolean>;
}

function resolvePath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringifyForUrl(value: unknown): string {
  if (value === undefined || value === null) return "";
  return encodeURIComponent(typeof value === "string" ? value : JSON.stringify(value));
}

function stringifyForBody(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? null);
}

/** Interpolates a template; input refs are required, secret/setting refs fall back to "". */
export function renderTemplate(template: string, context: RenderContext, options?: { urlMode?: boolean }): string {
  return template.replace(TEMPLATE_REF, (_match, scope: string, path: string) => {
    if (scope === "input") {
      const value = resolvePath(context.input, path);
      return options?.urlMode ? stringifyForUrl(value) : stringifyForBody(value);
    }
    if (scope === "secret") {
      const value = context.secrets?.[path];
      if (value === undefined) throw new Error(`Extension secret "${path}" is not configured.`);
      return value;
    }
    const setting = context.settings?.[path];
    if (setting === undefined) return "";
    return options?.urlMode ? stringifyForUrl(setting) : stringifyForBody(setting);
  });
}

/**
 * Guards and interpolates the endpoint URL of a tool for the given input.
 * Throws when the target host is private, not https, or not permitted.
 */
export function buildExtensionRequest(
  toolId: string,
  endpoint: ToolEndpoint,
  manifestPermissions: string[],
  grantedPermissions: string[],
  context: RenderContext,
): { url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs: number } {
  const rawHost = (() => {
    try {
      return new URL(endpoint.url).hostname;
    } catch {
      throw new Error(`Extension tool ${toolId}: endpoint URL is not a valid URL.`);
    }
  })();

  if (isPrivateHost(rawHost)) {
    throw new Error(`Extension tool ${toolId}: access to private host "${rawHost}" is forbidden.`);
  }
  const interpolatedUrl = renderTemplate(endpoint.url, context, { urlMode: true });
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(interpolatedUrl);
  } catch {
    throw new Error(`Extension tool ${toolId}: rendered URL is invalid.`);
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`Extension tool ${toolId}: only https endpoints are allowed.`);
  }
  const host = parsedUrl.hostname.toLowerCase();
  if (isPrivateHost(host)) {
    throw new Error(`Extension tool ${toolId}: access to private host "${host}" is forbidden.`);
  }
  assertPermissionsGranted(grantedPermissions, [`http.fetch:${host}`]);
  // The manifest itself must also have declared this host at review time.
  assertPermissionsGranted(manifestPermissions, [`http.fetch:${host}`]);

  const headers: Record<string, string> = {};
  for (const header of endpoint.headers ?? []) {
    const name = header.name.trim();
    if (name.toLowerCase() === "host") continue;
    headers[name] = renderTemplate(header.value, context);
  }
  if (endpoint.bodyTemplate && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }

  let body: string | undefined;
  if (endpoint.bodyTemplate) {
    body = renderTemplate(endpoint.bodyTemplate, context);
    try {
      JSON.parse(body);
    } catch {
      throw new Error(`Extension tool ${toolId}: rendered request body is not valid JSON.`);
    }
  } else if (["POST", "PUT", "PATCH"].includes(endpoint.method) && Object.keys(context.input).length > 0) {
    body = JSON.stringify(context.input);
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
  }

  return {
    url: parsedUrl.toString(),
    method: endpoint.method,
    headers,
    body,
    timeoutMs: endpoint.timeoutMs ?? 8_000,
  };
}

/** Reads a fetch Response safely: caps size, decodes text, parses JSON when possible. */
export async function readExtensionResponse(toolId: string, response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_OUTPUT_CHARS) {
    throw new Error(`Extension tool ${toolId}: response exceeds ${MAX_OUTPUT_CHARS} characters.`);
  }
  if (!response.ok) {
    const snippet = text.slice(0, 300);
    throw new Error(`Extension tool ${toolId}: endpoint returned HTTP ${response.status}. ${snippet}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Extension tool ${toolId}: response declared JSON but could not be parsed.`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Deep-renders workflow step inputs ({{input.*}} refers to accumulated results). */
export function renderStepInput(
  stepInput: Record<string, string | number | boolean | null>,
  context: RenderContext,
): Record<string, unknown> {
  const rendered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stepInput)) {
    if (typeof value === "string") {
      const exact = value.match(/^\{\{\s*input\.([a-zA-Z0-9_.-]+)\s*\}\}$/);
      if (exact) {
        const resolved = resolvePath(context.input, exact[1]);
        rendered[key] = resolved === undefined ? null : resolved;
        continue;
      }
      rendered[key] = renderTemplate(value, context);
      continue;
    }
    rendered[key] = value;
  }
  return rendered;
}
