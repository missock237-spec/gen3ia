import "server-only";

import { CONNECTIONS_CATALOG, getCatalogEntry, type ConnectionCategory } from "./composio/connections";
import { getComposioTools } from "./composio/tools";

/**
 * Sélecteur « @ » du chat agent : active un connecteur déjà connecté et
 * vérifié dans une conversation. L'utilisateur tape @ dans la messagerie,
 * choisit une application autorisée, et l'agent reçoit ses actions réelles.
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
      .filter((account) => account.verified && account.enabled)
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

  // Le sélecteur @ ne présente volontairement que les applications
  // réellement connectées et vérifiées. Une app du catalogue non connectée
  // doit d'abord être autorisée depuis /integrations.
  const pool = connected.filter((item) => item.connected);
  if (!query) return pool.slice(0, MAX_LIST);
  return pool
    .filter((item) =>
      item.label.toLowerCase().includes(query) ||
      item.toolkit.includes(query) ||
      item.description.toLowerCase().includes(query))
    .slice(0, MAX_LIST);
}

const MAX_ACTIONS_PER_TOOLKIT = 12;

/** Nombre maximal de connecteurs injectés automatiquement dans un chat agent. */
const MAX_AUTO_TOOLKITS = 16;

export interface ConnectedConnectorsContext {
  /** Slugs des toolkits réellement connectés (status ACTIVE + enabled). */
  toolkits: string[];
  /** Note de prompt listant les connecteurs + actions Composio disponibles. */
  note?: string;
}

/**
 * Découverte AUTOMATIQUE des connecteurs connectés de l'utilisateur.
 *
 * Contrairement au sélecteur « @ » (activation manuelle), les agents Gen3ia
 * doivent pouvoir utiliser TOUS les connecteurs au statut « connecté » sans
 * que l'utilisateur ait à les activer un par un. La note produite liste les
 * toolkits ACTIFS et leurs actions réelles (slugs Composio) pour que le
 * planificateur génère des étapes `composio.execute` exactes.
 *
 * Budget temps garanti : les appels Composio sont bornés (timedComposioCall)
 * et le pire cas reste borné par une course globale — un hub Composio lent
 * ne doit jamais bloquer un simple message de chat.
 */
export async function describeConnectedConnectorsForPrompt(userId: string, budgetMs = 9_000): Promise<ConnectedConnectorsContext> {
  const budget = <T>(promise: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`connectors budget ${ms}ms exceeded`)), ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });

  try {
    const { listHubConnections } = await import("./composio/connections");
    const accounts = await budget(listHubConnections(userId), Math.min(6_000, budgetMs));
    const toolkits = accounts
      .filter((account) => account.status === "ACTIVE" && account.enabled)
      .map((account) => account.toolkit)
      .slice(0, MAX_AUTO_TOOLKITS);

    if (toolkits.length === 0) return { toolkits: [] };

    let actionsByToolkit = new Map<string, string[]>();
    try {
      const { getComposio } = await import("./composio/client");
      const composio = getComposio();
      const toolsResponse = await budget(
        composio.tools.get(userId, { toolkits, limit: 100 }),
        Math.max(2_000, budgetMs - 6_000),
      );
      const list = Array.isArray(toolsResponse)
        ? toolsResponse
        : Array.isArray((toolsResponse as { items?: unknown[] })?.items)
          ? (toolsResponse as { items: unknown[] }).items
          : [];
      const actionsMap = new Map<string, string[]>();
      for (const tool of list) {
        const slug = (tool as { slug?: unknown })?.slug;
        const rawToolkit = (tool as { toolkit?: unknown })?.toolkit;
        const toolkit = String(
          rawToolkit && typeof rawToolkit === "object"
            ? (rawToolkit as { slug?: unknown }).slug ?? ""
            : rawToolkit ?? "",
        );
        if (typeof slug !== "string" || !slug || !toolkit) continue;
        const current = actionsMap.get(toolkit) ?? [];
        if (current.length < MAX_ACTIONS_PER_TOOLKIT) current.push(slug);
        actionsMap.set(toolkit, current);
      }
      actionsByToolkit = actionsMap;
    } catch {
      // Actions exactes indisponibles : la note liste quand même les toolkits
      // connectés — l'agent découvrira les actions à l'exécution.
    }

    const lines = toolkits.map((toolkit) => {
      const entry = getCatalogEntry(toolkit);
      const actions = actionsByToolkit.get(toolkit)?.length
        ? ` Actions disponibles : ${actionsByToolkit.get(toolkit)!.join(", ")}.`
        : "";
      return `- ${toolkit} (${entry?.label ?? toolkit}).${actions}`;
    });

    return {
      toolkits,
      note: [
        "[Connecteurs connectés de l'utilisateur (disponibles automatiquement) :",
        ...lines,
        "MULTI-CONNECTEURS : tu peux COMBINER PLUSIEURS connecteurs dans un même plan — ex. lire un email (gmail) puis créer une ligne de suivi (notion), ou chercher un contact (crm) puis poster un message (slack). Crée autant d'étapes composio.execute que nécessaire ; les étapes indépendantes s'exécutent en parallèle.",
        "Pour agir sur ces applications, utilise l'outil composio.execute avec un toolSlug exact d'une action listée et les arguments attendus. Toute action à effet externe restera soumise à validation avant exécution. Si une action requiert une connexion inexistante ou échoue, dis-le clairement au lieu d'inventer un résultat.]",
      ].join("\n"),
    };
  } catch {
    // Composio indisponible ou trop lent : les agents restent utilisables
    // sans connecteurs plutôt que bloqués.
    return { toolkits: [] };
  }
}

/**
 * Note de contexte injectée dans le prompt de l'agent quand des connecteurs
 * sont activés via @ : liste les actions réelles disponibles (slugs Composio)
 * pour que le planificateur utilise composio.execute avec des toolSlugs exacts.
 */
export async function describeConnectorsForPrompt(userId: string, toolkits: string[]): Promise<string | undefined> {
  const requested = [...new Set(
    toolkits
      .map((toolkit) => toolkit.trim().toLowerCase())
      .filter((toolkit) => /^[a-z0-9_]{2,64}$/.test(toolkit)),
  )].slice(0, 10);
  if (requested.length === 0) return undefined;

  let verified = new Set<string>();
  try {
    const { listHubConnections } = await import("./composio/connections");
    verified = new Set(
      (await listHubConnections(userId))
        .filter((account) => account.verified && account.enabled)
        .map((account) => account.toolkit),
    );
  } catch {
    return undefined;
  }

  const clean = requested.filter((toolkit) => verified.has(toolkit));
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
