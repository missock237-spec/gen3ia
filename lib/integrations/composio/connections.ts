import { getComposio } from "./client";
import { getAppUrl } from "@/lib/url/app-url";

/**
 * Connections Hub Composio générique.
 *
 * Contrairement à `ads.ts` (scopé publicité), ce module généralise le parcours
 * de connexion OAuth à l'ensemble des toolkits du catalogue. L'utilisateur
 * connecte un service depuis /integrations, puis les agents l'exécutent via
 * `composio.execute` ou les outils dérivés (social.publish…).
 */

export type ConnectionCategory =
  | "messaging"
  | "social"
  | "email_calendar"
  | "crm"
  | "ecommerce"
  | "developer"
  | "knowledge"
  | "data";

export interface CatalogEntry {
  /** Slug du toolkit côté Composio. */
  toolkit: string;
  label: string;
  description: string;
  category: ConnectionCategory;
  /** Type d'authentification principal attendu (informatif pour l'UI). */
  auth: "oauth" | "api_key" | "no_auth";
}

export const CONNECTIONS_CATALOG: CatalogEntry[] = [
  { toolkit: "github", label: "GitHub", description: "Repositories, issues and pull requests.", category: "developer", auth: "oauth" },
  { toolkit: "gmail", label: "Gmail", description: "Email and mailbox automation.", category: "email_calendar", auth: "oauth" },
  { toolkit: "slack", label: "Slack", description: "Messages, channels and notifications.", category: "messaging", auth: "oauth" },
  { toolkit: "googlecalendar", label: "Google Calendar", description: "Events and calendar automation.", category: "email_calendar", auth: "oauth" },
  { toolkit: "googledrive", label: "Google Drive", description: "Files and documents.", category: "knowledge", auth: "oauth" },
  { toolkit: "linkedin", label: "LinkedIn", description: "Professional social automation.", category: "social", auth: "oauth" },
  { toolkit: "instagram", label: "Instagram", description: "Instagram content automation.", category: "social", auth: "oauth" },
  { toolkit: "facebook", label: "Facebook", description: "Facebook automation.", category: "social", auth: "oauth" },
  { toolkit: "youtube", label: "YouTube", description: "YouTube channel automation.", category: "social", auth: "oauth" },
  { toolkit: "x", label: "X (Twitter)", description: "Posts and social publishing.", category: "social", auth: "oauth" },
  { toolkit: "whatsapp", label: "WhatsApp", description: "WhatsApp automation.", category: "messaging", auth: "oauth" },
  { toolkit: "telegram", label: "Telegram", description: "Messages, channels and remote approvals.", category: "messaging", auth: "api_key" },
  { toolkit: "notion", label: "Notion", description: "Pages, databases and knowledge.", category: "knowledge", auth: "oauth" },
  { toolkit: "hubspot", label: "HubSpot", description: "CRM and sales automation.", category: "crm", auth: "oauth" },
  { toolkit: "salesforce", label: "Salesforce", description: "CRM automation.", category: "crm", auth: "oauth" },
  { toolkit: "shopify", label: "Shopify", description: "Store, products and orders.", category: "ecommerce", auth: "oauth" },
  { toolkit: "stripe", label: "Stripe", description: "Payments and billing automation.", category: "ecommerce", auth: "api_key" },
  { toolkit: "googlesheets", label: "Google Sheets", description: "Spreadsheets and data capture.", category: "data", auth: "oauth" },
  { toolkit: "airtable", label: "Airtable", description: "Databases, records and automations.", category: "data", auth: "oauth" },
];

export const CONNECTION_CATEGORIES: ConnectionCategory[] = [
  "messaging",
  "social",
  "email_calendar",
  "crm",
  "ecommerce",
  "developer",
  "knowledge",
  "data",
];

const CATALOG_INDEX = new Map(CONNECTIONS_CATALOG.map((entry) => [entry.toolkit, entry]));

export function getCatalogEntry(toolkit: string): CatalogEntry | undefined {
  return CATALOG_INDEX.get(toolkit);
}

const TOOLKIT_SLUG_RE = /^[a-z0-9_]{2,64}$/;

/**
 * Garde-fou de durée pour les appels SDK Composio : sans lui, un Composio
 * suspendu (slow upstream, incident réseau) suspend la route API entière
 * jusqu'au kill de la plateforme — l'utilisateur voit un spinner infini sur
 * /integrations. 20 s couvrent le pire cas nominal observé (~5 s par page).
 */
const COMPOSIO_CALL_TIMEOUT_MS = 20_000;

export async function timedComposioCall<T>(operation: () => Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Composio timeout after ${COMPOSIO_CALL_TIMEOUT_MS}ms (${label})`)), COMPOSIO_CALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Autorise uniquement les toolkits du catalogue : jamais de connexion
 * arbitraire non déclarée (même principe que les permissions d'extensions).
 */
export function assertSupportedToolkit(toolkit: string): string {
  const normalized = toolkit.trim().toLowerCase();
  if (!TOOLKIT_SLUG_RE.test(normalized)) throw new Error("Invalid toolkit identifier.");
  return normalized;
}

export interface ToolkitCatalogItem {
  toolkit: string;
  label: string;
  description: string;
  logo: string | null;
  categories: string[];
  authSchemes: string[];
  managedBy: string;
  noAuth: boolean;
}

/**
 * Normalise un item toolkit brut (client HTTP snake_case) ou transformé
 * (wrapper SDK camelCase) vers la forme du catalogue Gen3ia.
 * Exporté pour les tests unitaires.
 */
export function mapRawToolkitItem(item: any): ToolkitCatalogItem {
  const categories = Array.isArray(item?.meta?.categories)
    ? item.meta.categories
    : Array.isArray(item?.categories)
      ? item.categories
      : [];
  return {
    toolkit: String(item?.slug ?? ""),
    label: String(item?.name ?? item?.slug ?? ""),
    description: String(item?.meta?.description ?? item?.description ?? ""),
    logo: item?.meta?.logo ?? item?.logo ?? item?.logo_url ?? null,
    categories: categories
      .map((category: any) =>
        typeof category === "string" ? category : category?.slug ?? category?.id ?? category?.name,
      )
      .filter(Boolean),
    authSchemes:
      item?.composio_managed_auth_schemes ?? item?.composioManagedAuthSchemes ?? item?.auth_schemes ?? item?.authSchemes ?? [],
    managedBy: item?.managed_by ?? item?.managedBy ?? "composio",
    noAuth: Boolean(item?.no_auth ?? item?.noAuth ?? false),
  };
}

/** Limite par page imposée par l'API Composio (/api/v3.1/toolkits). */
const TOOLKITS_PAGE_LIMIT = 1000;
/** Garde-fou d'agrégation : 5 pages = 5000 toolkits maximum par requête. */
const TOOLKITS_MAX_PAGES = 5;

/**
 * Liste les toolkits Composio via le client HTTP BRUT (composio.client).
 *
 * Pourquoi le client brut : le wrapper `composio.toolkits.get()` transforme la
 * réponse en simple TABLEAU et perd `next_cursor`/`total_items`/`search`, ce
 * qui rendait la pagination et la recherche serveur impossibles (le catalogue
 * restait vide ou tronqué à 1000 entrées).
 *
 * Sans `options.cursor`, TOUTES les pages sont agrégées (jusqu'à
 * TOOLKITS_MAX_PAGES) afin de renvoyer le catalogue complet — plus de 800
 * applications — en une seule réponse.
 */
export async function listComposioToolkits(options?: { category?: string; search?: string; cursor?: string; limit?: number }) {
  const composio = getComposio();
  const rawClient = (
    composio as unknown as {
      client: { toolkits: { list: (query: Record<string, unknown>) => Promise<any> } };
    }
  ).client.toolkits;
  if (!rawClient?.list) throw new Error("Composio raw toolkits client unavailable.");

  const aggregate = !options?.cursor;
  const maxPages = aggregate ? TOOLKITS_MAX_PAGES : 1;
  const pageLimit = Math.min(TOOLKITS_PAGE_LIMIT, Math.max(1, options?.limit ?? TOOLKITS_PAGE_LIMIT));

  let cursor: string | null = options?.cursor ?? null;
  const collected: any[] = [];
  let totalItems = 0;

  for (let page = 0; page < maxPages; page++) {
    const result = await timedComposioCall(() => rawClient.list({
      ...(options?.category ? { category: options.category } : {}),
      ...(options?.search ? { search: options.search } : {}),
      ...(cursor ? { cursor } : {}),
      limit: pageLimit,
      sort_by: "alphabetically",
      managed_by: "all",
      include_deprecated: false,
    }), `toolkits.list page ${page + 1}`);

    const items = Array.isArray(result?.items) ? result.items : Array.isArray(result) ? result : [];
    collected.push(...items);
    totalItems = Number(result?.total_items ?? 0) || collected.length;

    const next = typeof result?.next_cursor === "string" && result.next_cursor ? result.next_cursor : null;
    if (!next || collected.length >= totalItems) {
      cursor = null;
      break;
    }
    cursor = next;
  }

  return {
    items: collected.map(mapRawToolkitItem).filter((entry: ToolkitCatalogItem) => entry.toolkit),
    nextCursor: cursor ?? null,
    totalItems: Math.max(totalItems, collected.length),
  };
}

/** Valide l'existence réelle du toolkit côté Composio (appel une fois par connexion). */
export async function assertToolkitExists(toolkit: string): Promise<void> {
  const composio = getComposio();
  try {
    await timedComposioCall(() => composio.toolkits.get(toolkit), `toolkits.get ${toolkit}`);
  } catch {
    throw new Error(`Toolkit "${toolkit}" is not reachable through Composio. Check the catalog configuration.`);
  }
}

export async function authorizeToolkit(userId: string, toolkit: string) {
  if (!userId) throw new Error("userId is required.");
  const normalized = assertSupportedToolkit(toolkit);
  await assertToolkitExists(normalized);
  const callbackUrl = `${getAppUrl()}/integrations?connected=${encodeURIComponent(normalized)}`;

  const session = await timedComposioCall(
    () =>
      getComposio().create(userId, {
        manageConnections: {
          enable: true,
          callbackUrl,
          waitForConnections: false,
        },
      }),
    `create connection session ${normalized}`,
  );

  return timedComposioCall(() => session.authorize(normalized, { callbackUrl }), `authorize ${normalized}`);
}

export interface HubConnection {
  id: string;
  toolkit: string;
  label: string;
  category: ConnectionCategory | "other";
  status: string;
  enabled: boolean;
  verified: boolean;
}

function isActiveConnection(account: { status?: unknown; isDisabled?: unknown }): boolean {
  return String(account.status ?? "").toUpperCase() === "ACTIVE" && account.isDisabled !== true;
}

export interface VerifiedConnectionResult {
  verified: boolean;
  connection: HubConnection | null;
}

/**
 * Vérifie réellement qu'un compte Composio est passé à l'état ACTIVE.
 * Après OAuth, Composio peut conserver temporairement l'état en attente :
 * cette fonction patiente puis ne considère la connexion valide qu'après
 * confirmation ACTIVE côté Connected Accounts.
 */
export async function verifyToolkitConnection(
  userId: string,
  toolkit: string,
  timeoutMs = 12_000,
): Promise<VerifiedConnectionResult> {
  if (!userId) throw new Error("userId is required.");
  const normalized = assertSupportedToolkit(toolkit);
  const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, 30_000));

  do {
    const result = await timedComposioCall(
      () => getComposio().connectedAccounts.list({ userIds: [userId] }),
      "connectedAccounts.list verification " + normalized,
    );
    const account = result.items.find(
      (item) => item.toolkit?.slug === normalized && isActiveConnection(item),
    );
    if (account) {
      const info = catalogInfo(normalized);
      return {
        verified: true,
        connection: {
          id: account.id,
          toolkit: normalized,
          label: info.label,
          category: info.category,
          status: String(account.status ?? "ACTIVE"),
          enabled: !account.isDisabled,
          verified: true,
        },
      };
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);

  return { verified: false, connection: null };
}

function catalogInfo(toolkitSlug: string): { label: string; category: ConnectionCategory | "other" } {
  const entry = CATALOG_INDEX.get(toolkitSlug);
  if (entry) return { label: entry.label, category: entry.category };
  return { label: toolkitSlug, category: "other" };
}

/** Liste TOUTES les connexions Composio de l'utilisateur (hub + Ads hérité). */
export async function listHubConnections(userId: string): Promise<HubConnection[]> {
  if (!userId) throw new Error("userId is required.");
  const result = await timedComposioCall(
    () => getComposio().connectedAccounts.list({ userIds: [userId] }),
    `connectedAccounts.list ${userId}`,
  );
  return result.items
    .filter((account) => Boolean(account.toolkit?.slug))
    .map((account) => {
      const slug = account.toolkit?.slug ?? "unknown";
      const info = catalogInfo(slug);
      const verified = isActiveConnection(account);
      return {
        id: account.id,
        toolkit: slug,
        label: info.label,
        category: info.category,
        status: String(account.status ?? "UNKNOWN"),
        enabled: !account.isDisabled,
        verified,
      };
    });
}

/** Révocation avec vérification de propriété stricte (jamais de delete en angle). */
export async function revokeHubConnection(userId: string, connectionId: string): Promise<void> {
  if (!userId) throw new Error("userId is required.");
  if (!connectionId || connectionId.length > 256) throw new Error("A valid connection id is required.");
  const composio = getComposio();
  const accounts = await timedComposioCall(() => composio.connectedAccounts.list({ userIds: [userId] }), `connectedAccounts.list ${userId}`);
  const owned = accounts.items.find((item) => item.id === connectionId);
  if (!owned) throw new Error("Connection not found for this user.");
  await timedComposioCall(() => composio.connectedAccounts.delete(connectionId), `connectedAccounts.delete ${connectionId}`);
}

/** Découverte des actions disponibles pour un toolkit connecté. */
export async function getProjectToolkitTools(userId: string, projectId: string, toolkit: string, search?: string) {
  const { listDeveloperProjectConnectors } = await import("@/lib/developer/connectors");
  const connectors = await listDeveloperProjectConnectors(userId, projectId);
  const normalized = assertSupportedToolkit(toolkit);
  const connected = connectors.some((item) => item.toolkit === normalized && item.status === "active");
  if (!connected) throw new Error(`Toolkit "${normalized}" is not connected to this Gen3ia project.`);
  return getToolkitTools(userId, normalized, search);
}

export async function getProjectComposioTools(userId: string, projectId: string, search?: string) {
  const { listDeveloperProjectConnectors } = await import("@/lib/developer/connectors");
  const connectors = await listDeveloperProjectConnectors(userId, projectId);
  const toolkits = connectors.filter((item) => item.status === "active").map((item) => item.toolkit);
  if (toolkits.length === 0) return { items: [], nextCursor: null };
  return getComposio().tools.get(userId, { toolkits, ...(search ? { search } : {}), limit: 100 });
}

export async function getToolkitTools(userId: string, toolkit: string, search?: string) {
  if (!userId) throw new Error("userId is required.");
  const normalized = assertSupportedToolkit(toolkit);
  const composio = getComposio();
  return timedComposioCall(
    () =>
      composio.tools.get(userId, {
        toolkits: [normalized],
        ...(search ? { search, limit: 25 } : { limit: 100 }),
      }),
    `tools.get ${normalized}`,
  );
}
