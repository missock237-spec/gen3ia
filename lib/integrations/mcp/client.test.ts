import { describe, expect, it, vi } from "vitest";

import { McpClient, McpClientError } from "./client";

/** Fabrique une Response JSON-RPC (transport streamable HTTP). */
function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function sseResponse(payloads: unknown[]): Response {
  const body = payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("client MCP", () => {
  it("initialize effectue la poignée de main JSON-RPC et retourne le nom du serveur", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "Drive MCP" }, protocolVersion: "2025-03-26" },
    }));

    const client = new McpClient({ url: "https://exemple.com/mcp", fetchImpl });
    const result = await client.initialize();

    expect(result.serverName).toBe("Drive MCP");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://exemple.com/mcp");
    const body = JSON.parse(String(init.body));
    expect(body.method).toBe("initialize");
    expect(body.params.protocolVersion).toBe("2025-03-26");
  });

  it("listTools normalise le catalogue d'outils", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "search", description: "Chercher des fichiers", inputSchema: { type: "object" } },
          { description: "sans nom — ignoré" },
          { name: "create", description: "Créer un document" },
        ],
      },
    }));

    const client = new McpClient({ url: "https://exemple.com/mcp", fetchImpl });
    const tools = await client.listTools();

    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({ name: "search", description: "Chercher des fichiers", inputSchema: { type: "object" } });
  });

  it("callTool concatène le contenu textuel et signale les erreurs outil", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "Résultat partiel." }, { type: "text", text: "Suite." }], isError: true },
    }));

    const client = new McpClient({ url: "https://exemple.com/mcp", fetchImpl });
    const output = await client.callTool("search", { q: "test" });

    expect(output.text).toBe("Résultat partiel.\nSuite.");
    expect(output.isError).toBe(true);
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown[])[1] && (fetchImpl.mock.calls[0] as [string, { body: string }])[1].body));
    expect(body.params).toEqual({ name: "search", arguments: { q: "test" } });
  });

  it("lit les réponses SSE (flux streamable)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      { jsonrpc: "2.0", method: "notifications/progress" },
      { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "a", description: "", inputSchema: {} }] } },
    ]));

    const client = new McpClient({ url: "https://exemple.com/mcp", fetchImpl });
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["a"]);
  });

  it("transforme les erreurs JSON-RPC et HTTP en McpClientError", async () => {
    const rpcError = new McpClient({ url: "https://exemple.com/mcp", fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Méthode inconnue" } })) });
    await expect(rpcError.listTools()).rejects.toThrowError("Méthode inconnue");

    const httpError = new McpClient({ url: "https://exemple.com/mcp", fetchImpl: vi.fn().mockResolvedValue(new Response("boom", { status: 503 })) });
    await expect(httpError.listTools()).rejects.toBeInstanceOf(McpClientError);

    const networkError = new McpClient({ url: "https://exemple.com/mcp", fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) });
    await expect(networkError.listTools()).rejects.toThrowError("injoignable");
  });
});
