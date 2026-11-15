/**
 * Client MCP (Model Context Protocol) de Gen3ia.
 *
 * Transport : « Streamable HTTP » — chaque appel est un POST JSON-RPC 2.0
 * vers l'endpoint déclaré par l'utilisateur. La réponse peut être du JSON
 * pur ou un flux SSE : les deux formes sont normalisées ici.
 * Implémente initialize → notifications/initialized → tools/list → tools/call.
 *
 * Task 143 — axe 4 : le client capture et RÉUTILISE l'identifiant de session
 * `Mcp-Session-Id` renvoyé par les serveurs stateful (spec Streamable HTTP) :
 * une seule poignée de main suffit pour la durée de vie du client, les
 * serveurs qui l'exigent fonctionnent enfin. Le timeout reste configurable
 * (défaut 20 s) et les headers utilisateur ne peuvent plus écraser
 * `content-type`/`accept` (garde d'intégrité du protocole).
 */

const PROTOCOL_VERSION = "2025-03-26";
const REQUEST_TIMEOUT_MS = 20_000;

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpCallOutput {
  text: string;
  isError: boolean;
}

export class McpClientError extends Error {
  constructor(message: string, readonly code?: number | string) {
    super(message);
    this.name = "McpClientError";
  }
}

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number | string; message?: string; data?: unknown };
};

export interface McpClientOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class McpClient {
  private nextId = 1;
  private readonly fetchImpl: typeof fetch;
  /** Session Streamable HTTP (si le serveur en émet une) — renvoyée à chaque appel. */
  private sessionId: string | null = null;

  constructor(private readonly options: McpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Headers protocole — les headers utilisateur ne peuvent PAS les écraser. */
  private requestHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...sanitizeUserHeaders(this.options.headers),
    };
  }

  private async request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.url, {
        method: "POST",
        headers: this.requestHeaders(),
        body,
        signal: controller.signal,
      });
    } catch (error) {
      throw new McpClientError(
        error instanceof Error && error.name === "AbortError"
          ? "Le serveur MCP n'a pas répondu à temps."
          : `Serveur MCP injoignable : ${error instanceof Error ? error.message : "erreur réseau"}`,
      );
    } finally {
      clearTimeout(timer);
    }

    // Session stateful : capture de l'identifiant (spec Streamable HTTP).
    const sessionHeader = response.headers.get("mcp-session-id");
    if (sessionHeader && sessionHeader.trim()) this.sessionId = sessionHeader.trim();

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new McpClientError(`Le serveur MCP a répondu ${response.status}${detail ? ` : ${detail.slice(0, 200)}` : ""}`, response.status);
    }

    const payload = await parseResponsePayload(response, id);
    if (payload.error) {
      throw new McpClientError(payload.error.message ?? "Erreur MCP inconnue", payload.error.code);
    }
    return payload.result as T;
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    const body = JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    try {
      await this.fetchImpl(this.options.url, {
        method: "POST",
        headers: this.requestHeaders(),
        body,
      });
    } catch {
      // Les notifications ne sont pas critiques (best effort).
    }
  }

  /** Poignée de main obligatoire avant tout usage : valide l'URL et les credentials. */
  async initialize(): Promise<{ serverName: string; protocolVersion: string; sessionId: string | null }> {
    const result = await this.request<{ serverInfo?: { name?: string }; protocolVersion?: string }>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "gen3ia", version: "1.0.0" },
    });
    await this.notify("notifications/initialized");
    return {
      serverName: result.serverInfo?.name ?? "serveur MCP",
      protocolVersion: result.protocolVersion ?? PROTOCOL_VERSION,
      sessionId: this.sessionId,
    };
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.request<{ tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }> }>("tools/list", {});
    const tools = Array.isArray(result.tools) ? result.tools : [];
    return tools
      .filter((tool) => typeof tool?.name === "string" && tool.name.trim().length > 0)
      .map((tool) => ({
        name: String(tool.name).slice(0, 160),
        description: typeof tool.description === "string" ? tool.description.slice(0, 500) : "",
        inputSchema: tool.inputSchema ?? { type: "object" },
      }))
      .slice(0, 100);
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpCallOutput> {
    const result = await this.request<{
      content?: Array<{ type?: unknown; text?: unknown }>;
      isError?: boolean;
    }>("tools/call", { name: toolName, arguments: args });

    const parts = Array.isArray(result.content) ? result.content : [];
    const text = parts
      .map((part) => (typeof part?.text === "string" ? part.text : typeof part === "string" ? part : JSON.stringify(part)))
      .filter(Boolean)
      .join("\n");

    return {
      text: text.slice(0, 30_000) || "Le serveur MCP n'a retourné aucun contenu.",
      isError: result.isError === true,
    };
  }
}

/** Retire les headers protocole des headers utilisateur (jamais écrasables). */
function sanitizeUserHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.trim().toLowerCase();
    if (normalized === "content-type" || normalized === "accept" || normalized === "mcp-session-id") continue;
    if (!key.trim() || !value) continue;
    sanitized[key.trim()] = value;
  }
  return sanitized;
}

/** Normalise la réponse : JSON direct ou flux SSE (lignes « data: {...} »). */
async function parseResponsePayload(response: Response, requestId: number): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();

  if (contentType.includes("text/event-stream")) {
    const events = raw
      .split("\n\n")
      .map((block) => block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n"))
      .filter(Boolean);
    for (const event of events) {
      try {
        const parsed = JSON.parse(event) as JsonRpcResponse;
        if (parsed.id === requestId || parsed.result !== undefined || parsed.error) return parsed;
      } catch {
        // Segment SSE non JSON : ignoré.
      }
    }
    throw new McpClientError("Le serveur MCP n'a pas renvoyé de réponse exploitable (flux SSE).");
  }

  try {
    return JSON.parse(raw) as JsonRpcResponse;
  } catch {
    throw new McpClientError("Le serveur MCP n'a pas renvoyé de JSON valide.");
  }
}
