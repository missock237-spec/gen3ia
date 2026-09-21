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
} from "./store";

/**
 * Cycle de vie des serveurs MCP d'un utilisateur :
 *  - ajout = poignée de main MCP (initialize) + découverte des outils
 *    (tools/list) : un endpoint qui ne répond pas correctement est refusé ;
 *  - rafraîchissement = re-synchronisation du catalogue d'outils ;
 *  - exécution = tools/call via l'outil Gen3ia « mcp.call » (tool.ts).
 */

export class McpServiceError extends Error {}

export async function addUserServer(userId: string, payload: unknown): Promise<McpServer> {
  const input = McpServerSchema.parse(payload);
  if ((await countUserServers(userId)) >= MAX_SERVERS_PER_USER) {
    throw new McpServiceError(`Limite de ${MAX_SERVERS_PER_USER} serveurs MCP atteinte. Supprimez un serveur avant d'en ajouter un autre.`);
  }

  let url: URL;
  try {
    url = await assertPublicHttpUrl(input.url);
  } catch {
    throw new McpServiceError("L'URL du serveur MCP doit être une URL HTTP(S) publique valide.");
  }

  const client = new McpClient({ url: url.toString(), headers: input.headers });
  await client.initialize();
  const tools = await client.listTools();

  const id = await saveServer(userId, { ...input, url: url.toString() }, tools.map((tool) => ({ name: tool.name, description: tool.description })));
  const created = await getServer(userId, id);
  if (!created) throw new McpServiceError("Le serveur MCP n'a pas pu être créé.");
  return created;
}

export async function refreshUserServer(userId: string, id: string): Promise<McpServer> {
  const found = await getServerWithHeaders(userId, id);
  if (!found) throw new McpServiceError("Serveur MCP introuvable.");
  try {
    const client = new McpClient({ url: found.server.url, headers: found.headers });
    await client.initialize();
    const tools = await client.listTools();
    await updateServerTools(userId, id, tools.map((tool) => ({ name: tool.name, description: tool.description })));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Découverte impossible";
    await updateServerError(userId, id, message).catch(() => undefined);
    throw new McpServiceError(message);
  }
  const updated = await getServer(userId, id);
  if (!updated) throw new McpServiceError("Serveur MCP introuvable.");
  return updated;
}

export async function toggleUserServer(userId: string, id: string, enabled: boolean): Promise<void> {
  if (!(await getServer(userId, id))) throw new McpServiceError("Serveur MCP introuvable.");
  await setServerEnabled(userId, id, enabled);
}

export async function removeUserServer(userId: string, id: string): Promise<void> {
  if (!(await deleteServer(userId, id))) throw new McpServiceError("Serveur MCP introuvable.");
}

export async function listUserServers(userId: string): Promise<McpServer[]> {
  return listServers(userId);
}

/** Exécution d'un outil MCP pour le compte d'un agent (outil « mcp.call »). */
export async function callUserTool(params: {
  userId: string;
  serverId: string;
  tool: string;
  args?: Record<string, unknown>;
}): Promise<{ text: string; isError: boolean }> {
  const found = await getServerWithHeaders(params.userId, params.serverId);
  if (!found) throw new McpServiceError("Serveur MCP introuvable ou non autorisé.");
  if (!found.server.enabled) throw new McpServiceError("Ce serveur MCP est désactivé. Réactivez-le depuis la page Intégrations.");
  const client = new McpClient({ url: found.server.url, headers: found.headers });
  return client.callTool(params.tool, params.args ?? {});
}

/**
 * Découverte automatique d'outils pour le prompt de l'agent : décrit les
 * serveurs MCP connectés (id, nom, outils) pour que le planificateur sache
 * exactement quels outils sont disponibles et comment les appeler.
 * Retourne undefined si aucun serveur actif — jamais d'erreur.
 */
export async function describeServersForPrompt(userId: string): Promise<string | undefined> {
  try {
    const servers = (await listUserServers(userId)).filter((server) => server.enabled && server.tools.length > 0);
    if (servers.length === 0) return undefined;
    const lines = servers.map((server) =>
      `- serverId: ${server.id} | nom: ${server.name} | outils: ${server.tools.map((tool) => tool.name).join(", ")}`,
    );
    return [
      "[Serveurs MCP connectés par l'utilisateur — des outils externes supplémentaires sont disponibles via l'outil mcp.call avec { serverId, tool, args } :]",
      ...lines,
    ].join("\n");
  } catch {
    return undefined;
  }
}
