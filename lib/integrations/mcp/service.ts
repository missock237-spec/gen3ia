import { assertPublicHttpUrl } from "@/lib/security/url-safety";
import { McpClient } from "./client";
import {
  McpServerSchema,
  countUserServers,
  deleteServer,
  getServer,
  getServerWithHeaders,
  listServers,
  saveServer,
  setServerEnabled,
  updateServerError,
  updateServerTools,
  MAX_SERVERS_PER_USER,
  type McpServer,
  type McpServerTool,
} from "./store";

/**
 * Cycle de vie des serveurs MCP d'un utilisateur :
 *  - ajout = poignée de main MCP (initialize) + découverte des outils
 *    (tools/list) : un endpoint qui ne répond pas correctement est refusé ;
 *  - rafraîchissement = re-synchronisation du catalogue d'outils ;
 *  - exécution = tools/call via l'outil Gen3ia « mcp.call » (tool.ts).
 *
 * Task 143 — axe 4 :
 *  - erreurs TYLÉES (code machine → statut HTTP propre, plus de matching de
 *    chaînes FR côté route) ;
 *  - re-validation SSRF de l'URL À CHAQUE exécution (anti-TOCTOU/DNS
 *    rebinding, cache court par URL) ;
 *  - clients RÉUTILISÉS par serveur (session `Mcp-Session-Id` capturée à
 *    l'initialisation, TTL 10 min) : les serveurs stateful fonctionnent ;
 *  - prompt enrichi : descriptions + schémas d'entrée des outils.
 */

export type McpServiceErrorCode =
  | "invalid_url"
  | "limit_reached"
  | "unreachable"
  | "not_found"
  | "disabled";

export class McpServiceError extends Error {
  constructor(message: string, readonly code: McpServiceErrorCode = "unreachable") {
    super(message);
    this.name = "McpServiceError";
  }
}

/** Statut HTTP associé à chaque code d'erreur (route API). */
export function mcpServiceErrorStatus(code: McpServiceErrorCode): number {
  switch (code) {
    case "not_found":
      return 404;
    case "limit_reached":
      return 409;
    case "invalid_url":
      return 400;
    case "disabled":
      return 409;
    default:
      return 502;
  }
}

export async function addUserServer(userId: string, payload: unknown): Promise<McpServer> {
  const input = McpServerSchema.parse(payload);
  if ((await countUserServers(userId)) >= MAX_SERVERS_PER_USER) {
    throw new McpServiceError(
      `Limite de ${MAX_SERVERS_PER_USER} serveurs MCP atteinte. Supprimez un serveur avant d'en ajouter un autre.`,
      "limit_reached",
    );
  }

  let url: URL;
  try {
    url = await assertPublicHttpUrl(input.url);
  } catch {
    throw new McpServiceError("L'URL du serveur MCP doit être une URL HTTP(S) publique valide.", "invalid_url");
  }

  const client = new McpClient({ url: url.toString(), headers: input.headers });
  let tools: McpServerTool[];
  try {
    await client.initialize();
    tools = await listToolSummaries(client);
  } catch (error) {
    throw new McpServiceError(
      error instanceof Error ? error.message : "Le serveur MCP n'a pas pu être contacté.",
      "unreachable",
    );
  }

  const id = await saveServer(userId, { ...input, url: url.toString() }, tools);
  const created = await getServer(userId, id);
  if (!created) throw new McpServiceError("Le serveur MCP n'a pas pu être créé.", "not_found");
  return created;
}

export async function refreshUserServer(userId: string, id: string): Promise<McpServer> {
  const found = await getServerWithHeaders(userId, id);
  if (!found) throw new McpServiceError("Serveur MCP introuvable.", "not_found");
  try {
    const client = await clientForUrl(found.server.url, found.headers);
    const tools = await listToolSummaries(client);
    await updateServerTools(userId, id, tools);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Découverte impossible";
    await updateServerError(userId, id, message).catch(() => undefined);
    throw new McpServiceError(message, "unreachable");
  }
  const updated = await getServer(userId, id);
  if (!updated) throw new McpServiceError("Serveur MCP introuvable.", "not_found");
  return updated;
}

export async function toggleUserServer(userId: string, id: string, enabled: boolean): Promise<void> {
  if (!(await getServer(userId, id))) throw new McpServiceError("Serveur MCP introuvable.", "not_found");
  await setServerEnabled(userId, id, enabled);
}

export async function removeUserServer(userId: string, id: string): Promise<void> {
  if (!(await deleteServer(userId, id))) throw new McpServiceError("Serveur MCP introuvable.", "not_found");
}

export async function listUserServers(userId: string): Promise<McpServer[]> {
  return listServers(userId);
}

/* ------------------------------------------------------------------ */
/* Task 143 — exécution : clients réutilisés + re-validation SSRF      */
/* ------------------------------------------------------------------ */

/** Clients MCP initialisés par (userId, serverId) — TTL 10 min. */
const CLIENT_TTL_MS = 10 * 60 * 1000;
const clientCache = new Map<string, { client: McpClient; expiresAt: number }>();

function cacheKey(userId: string, serverId: string): string {
  return `${userId}:${serverId}`;
}

/** Évince les entrées expirées (déclenché à l'écriture). */
function pruneClientCache(): void {
  const now = Date.now();
  for (const [key, entry] of clientCache) {
    if (entry.expiresAt <= now) clientCache.delete(key);
  }
}

/** Validation SSRF de l'URL (cache 60 s par URL — la garde DNS coûte cher). */
const SSRF_CACHE_TTL_MS = 60_000;
const ssrfCache = new Map<string, { at: number }>();

async function assertUrlAllowed(url: string): Promise<void> {
  const cached = ssrfCache.get(url);
  if (cached && Date.now() - cached.at < SSRF_CACHE_TTL_MS) return;
  await assertPublicHttpUrl(url);
  ssrfCache.set(url, { at: Date.now() });
  if (ssrfCache.size > 500) {
    const oldest = [...ssrfCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) ssrfCache.delete(oldest[0]);
  }
}

/** Client MCP initialisé pour l'URL (poignée de main UNE fois par TTL). */
async function clientForUrl(url: string, headers: Record<string, string>): Promise<McpClient> {
  await assertUrlAllowed(url);
  const client = new McpClient({ url, headers });
  await client.initialize();
  return client;
}

/** Client réutilisé par serveur (session Mcp-Session-Id conservée). */
async function clientForServer(userId: string, serverId: string, url: string, headers: Record<string, string>): Promise<McpClient> {
  const key = cacheKey(userId, serverId);
  const cached = clientCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.client;

  const client = await clientForUrl(url, headers);
  if (clientCache.size > 100) pruneClientCache();
  clientCache.set(key, { client, expiresAt: Date.now() + CLIENT_TTL_MS });
  return client;
}

/** Invalide le client caché d'un serveur (désactivation/suppression/erreur). */
export function invalidateMcpClient(userId: string, serverId: string): void {
  clientCache.delete(cacheKey(userId, serverId));
}

/** Découverte des outils sous forme de résumés persistables (schéma inclus). */
async function listToolSummaries(client: McpClient): Promise<McpServerTool[]> {
  const tools = await client.listTools();
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

/** Exécution d'un outil MCP pour le compte d'un agent (outil « mcp.call »). */
export async function callUserTool(params: {
  userId: string;
  serverId: string;
  tool: string;
  args?: Record<string, unknown>;
}): Promise<{ text: string; isError: boolean }> {
  const found = await getServerWithHeaders(params.userId, params.serverId);
  if (!found) throw new McpServiceError("Serveur MCP introuvable ou non autorisé.", "not_found");
  if (!found.server.enabled) {
    throw new McpServiceError("Ce serveur MCP est désactivé. Réactivez-le depuis la page Intégrations.", "disabled");
  }
  try {
    const client = await clientForServer(params.userId, params.serverId, found.server.url, found.headers);
    return await client.callTool(params.tool, params.args ?? {});
  } catch (error) {
    // Un échec d'exécution invalide le client caché (session possiblement
    // morte) et trace l'erreur sur le serveur pour la supervision UI.
    invalidateMcpClient(params.userId, params.serverId);
    const message = error instanceof Error ? error.message : "Exécution impossible";
    await updateServerError(params.userId, params.serverId, message).catch(() => undefined);
    throw new McpServiceError(message, "unreachable");
  }
}

/**
 * Découverte automatique d'outils pour le prompt de l'agent : décrit les
 * serveurs MCP connectés (id, nom, outils + descriptions + schémas d'entrée)
 * pour que le planificateur sache exactement quels outils sont disponibles
 * et comment les appeler. Retourne undefined si aucun serveur actif —
 * jamais d'erreur.
 */
export async function describeServersForPrompt(userId: string): Promise<string | undefined> {
  try {
    const servers = (await listUserServers(userId)).filter((server) => server.enabled && server.tools.length > 0);
    if (servers.length === 0) return undefined;
    const lines = servers.map((server) => {
      const tools = server.tools
        .slice(0, 20)
        .map((tool) => {
          const description = tool.description ? ` — ${tool.description.slice(0, 160)}` : "";
          const schema = formatSchemaForPrompt(tool.inputSchema);
          return `    · ${tool.name}${description}${schema ? ` | arguments : ${schema}` : " | (aucun argument)"}`;
        })
        .join("\n");
      return `- serverId: ${server.id} | nom: ${server.name} | outils :\n${tools}`;
    });
    return [
      "[Serveurs MCP connectés par l'utilisateur — des outils externes supplémentaires sont disponibles via l'outil mcp.call avec { serverId, tool, args }. Respecte STRICTEMENT le schéma d'arguments indiqué pour chaque outil :]",
      ...lines,
    ].join("\n");
  } catch {
    return undefined;
  }
}

/** Schéma JSON compact pour le prompt (≤ 240 caractères, propriétés clés). */
function formatSchemaForPrompt(schema: unknown): string | null {
  if (!schema || typeof schema !== "object") return null;
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (!properties || typeof properties !== "object") return null;
  const entries = Object.entries(properties).slice(0, 8);
  if (entries.length === 0) return null;
  try {
    const compact = entries
      .map(([key, value]) => {
        const type = (value as { type?: unknown })?.type;
        const required = Array.isArray((schema as { required?: unknown[] }).required)
          && ((schema as { required?: unknown[] }).required as unknown[]).includes(key);
        return `${key}${typeof type === "string" ? `: ${type}` : ""}${required ? " (requis)" : ""}`;
      })
      .join(", ");
    return compact.length > 240 ? `${compact.slice(0, 237)}…` : compact;
  } catch {
    return null;
  }
}
