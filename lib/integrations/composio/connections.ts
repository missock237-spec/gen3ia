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
  { toolkit: "whatsapp", label: "WhatsApp", description: "WhatsApp automation.", category: "messaging", auth: "oauth" },
  { toolkit: "notion", label: "Notion", description: "Pages, databases and knowledge.", category: "knowledge", auth: "oauth" },
  { toolkit: "hubspot", label: "HubSpot", description: "CRM and sales automation.", category: "crm", auth: "oauth" },
  { toolkit: "salesforce", label: "Salesforce", description: "CRM automation.", category: "crm", auth: "oauth" },
  { toolkit: "shopify", label: "Shopify", description: "Store, products and orders.", category: "ecommerce", auth: "oauth" },
  { toolkit: "stripe", label: "Stripe", description: "Payments and billing automation.", category: "ecommerce", auth: "api_key" },
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
 * Autorise uniquement les toolkits du catalogue : jamais de connexion
 * arbitraire non déclarée (même principe que les permissions d'extensions).
 */
export function assertSupportedToolkit(toolkit: string): string {
  const normalized = toolkit.trim().toLowerCase();
  if (!TOOLKIT_SLUG_RE.test(normalized)) throw new Error("Invalid toolkit identifier.");
  return normalized;
}

export async function listComposioToolkits(options?: { category?: string; search?: string; cursor?: string; limit?: number }) {
  const composio = getComposio();
  const result = await composio.toolkits.list({
    ...(options?.category ? { category: options.category } : {}),
    ...(options?.search ? { search: options.search } : {}),
    ...(options?.cursor ? { cursor: options.cursor } : {}),
    limit: Math.min(50, Math.max(1, options?.limit ?? 50)),
    managed_by: "all",
    include_deprecated: false,
  } as never);
  const items = (result as any)?.items ?? [];
  return {
    items: items.map((item: any) => ({
      toolkit: item.slug,
      label: item.name ?? item.slug,
      description: item.description ?? "",
      logo: item.logo ?? item.logo_url ?? null,
      categories: item.categories ?? [],
      authSchemes: item.composio_managed_auth_schemes ?? item.auth_schemes ?? [],
      managedBy: item.managed_by ?? "composio",
    })),
    nextCursor: (result as any)?.next_cursor ?? (result as any)?.nextCursor ?? null,
  };
}

/** Valide l'existence réelle du toolkit côté Composio (appel une fois par connexion). */
export async function assertToolkitExists(toolkit: string): Promise<void> {
  const composio = getComposio();
  try {
    await composio.toolkits.get(toolkit);
  } catch {
    throw new Error(`Toolkit "${toolkit}" is not reachable through Composio. Check the catalog configuration.`);
  }
}

export async function authorizeToolkit(userId: string, toolkit: string) {
  if (!userId) throw new Error("userId is required.");
  const normalized = assertSupportedToolkit(toolkit);
  await assertToolkitExists(normalized);
  const callbackUrl = `${getAppUrl()}/integrations?connected=${encodeURIComponent(normalized)}`;

  const session = await getComposio().create(userId, {
    manageConnections: {
      enable: true,
      callbackUrl,
      waitForConnections: false,
    },
  });

  return session.authorize(normalized, { callbackUrl });
}

export interface HubConnection {
  id: string;
  toolkit: string;
  label: string;
  category: ConnectionCategory | "other";
  status: string;
  enabled: boolean;
}

function catalogInfo(toolkitSlug: string): { label: string; category: ConnectionCategory | "other" } {
  const entry = CATALOG_INDEX.get(toolkitSlug);
  if (entry) return { label: entry.label, category: entry.category };
  return { label: toolkitSlug, category: "other" };
}

/** Liste TOUTES les connexions Composio de l'utilisateur (hub + Ads hérité). */
export async function listHubConnections(userId: string): Promise<HubConnection[]> {
  if (!userId) throw new Error("userId is required.");
  const result = await getComposio().connectedAccounts.list({ userIds: [userId] });
  return result.items
    .filter((account) => Boolean(account.toolkit?.slug))
    .map((account) => {
      const slug = account.toolkit?.slug ?? "unknown";
      const info = catalogInfo(slug);
      return {
        id: account.id,
        toolkit: slug,
        label: info.label,
        category: info.category,
        status: account.status,
        enabled: !account.isDisabled,
      };
    });
}

/** Révocation avec vérification de propriété stricte (jamais de delete en angle). */
export async function revokeHubConnection(userId: string, connectionId: string): Promise<void> {
  if (!userId) throw new Error("userId is required.");
  if (!connectionId || connectionId.length > 256) throw new Error("A valid connection id is required.");
  const composio = getComposio();
  const accounts = await composio.connectedAccounts.list({ userIds: [userId] });
  const owned = accounts.items.find((item) => item.id === connectionId);
  if (!owned) throw new Error("Connection not found for this user.");
  await composio.connectedAccounts.delete(connectionId);
}

/** Découverte des actions disponibles pour un toolkit connecté. */
export async function getToolkitTools(userId: string, toolkit: string, search?: string) {
  if (!userId) throw new Error("userId is required.");
  const normalized = assertSupportedToolkit(toolkit);
  const composio = getComposio();
  return composio.tools.get(userId, {
    toolkits: [normalized],
    ...(search ? { search, limit: 25 } : { limit: 100 }),
  });
}
