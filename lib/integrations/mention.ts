import "server-only";

import { CONNECTIONS_CATALOG, getCatalogEntry, type ConnectionCategory } from "./composio/connections";
import { getComposioTools } from "./composio/tools";

/**
 * Sélecteur « @ » du chat agent : active un connecteur dans une conversation.
 * L'utilisateur tape @ dans la messagerie, choisit une application, et
 * l'agent reçoit le contexte (actions réelles disponibles) pour agir dessus.
 */

export interface MentionConnector {
  toolkit: string;
  label: string;
  description: string;
  category: ConnectionCategory | "other";
  /** true si l'utilisateur possède déjà une connexion active pour ce toolkit. */
  connected: boolean;
}

const MAX_LIST = 30;

/** Connecteurs du sélecteur @ : connexions actives d'abord, catalogue ensuite. */
export async function listMentionConnectors(userId: string, search?: string): Promise<MentionConnector[]> {
  const query = search?.trim().toLowerCase() ?? "";

  let connected: MentionConnector[] = [];
  try {
    const { listHubConnections } = await import("./composio/connections");
    const accounts = await listHubConnections(userId);
    connected = accounts
      .filter((account) => account.status === "ACTIVE" && account.enabled)
      .map((account) => {
        const entry = getCatalogEntry(account.toolkit);
        return {
          toolkit: account.toolkit,
          label: entry?.label ?? account.label,
          description: entry?.description ?? "Application connectée à votre espace.",
          category: entry?.category ?? account.category,
          connected: true,
        };
      });
  } catch {
    // Composio indisponible : le sélecteur retombe sur le catalogue statique.
  }

  const known = new Set(connected.map((item) => item.toolkit));
  const catalog: MentionConnector[] = CONNECTIONS_CATALOG
    .filter((entry) => !known.has(entry.toolkit))
    .map((entry) => ({ toolkit: entry.toolkit, label: entry.label, description: entry.description, category: entry.category, connected: false }));

  const pool = [...connected, ...catalog];
  if (!query) return pool.slice(0, MAX_LIST);
  return pool
    .filter((item) =>
      item.label.toLowerCase().includes(query) ||
      item.toolkit.includes(query) ||
      item.description.toLowerCase().includes(query))
    .slice(0, MAX_LIST);
}

const MAX_ACTIONS_PER_TOOLKIT = 12;

/**
 * Note de contexte injectée dans le prompt de l'agent quand des connecteurs
 * sont activés via @ : liste les actions réelles disponibles (slugs Composio)
 * pour que le planificateur utilise composio.execute avec des toolSlugs exacts.
 */
export async function describeConnectorsForPrompt(userId: string, toolkits: string[]): Promise<string | undefined> {
  const clean = [...new Set(
    toolkits
      .map((toolkit) => toolkit.trim().toLowerCase())
      .filter((toolkit) => /^[a-z0-9_]{2,64}$/.test(toolkit)),
  )].slice(0, 10);
  if (clean.length === 0) return undefined;

  const lines: string[] = [];
  for (const toolkit of clean) {
    const entry = getCatalogEntry(toolkit);
    let actions = "";
    try {
      const tools = await getComposioTools(userId, [toolkit]);
      const list = Array.isArray(tools) ? tools : [];
      const slugs = list
        .map((tool) => (tool as { slug?: unknown })?.slug)
        .filter((slug): slug is string => typeof slug === "string" && slug.length > 0)
        .slice(0, MAX_ACTIONS_PER_TOOLKIT);
      if (slugs.length > 0) actions = ` Actions disponibles : ${slugs.join(", ")}.`;
    } catch {
      // Les actions exactes sont indisponibles : l'agent cherchera à l'exécution.
    }
    lines.push(`- @${toolkit} (${entry?.label ?? toolkit}).${actions}`);
  }

  return [
    "[Connecteurs activés par l'utilisateur pour cette conversation (sélecteur @) :",
    ...lines,
    "Pour agir sur ces applications, utilise l'outil composio.execute avec le toolSlug exact d'une action listée et les arguments attendus. Si une action requiert une connexion inexistante ou échoue, dis-le clairement au lieu d'inventer un résultat.]",
  ].join("\n");
}
