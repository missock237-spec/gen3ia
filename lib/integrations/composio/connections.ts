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
  // ---- Messagerie ----
  { toolkit: "whatsapp", label: "WhatsApp", description: "Messages et notifications WhatsApp Business pilotés par vos agents.", category: "messaging", auth: "oauth" },
  { toolkit: "telegram", label: "Telegram", description: "Envoi de messages, alertes et approbations via un bot Telegram.", category: "messaging", auth: "api_key" },
  { toolkit: "slack", label: "Slack", description: "Publications et alertes dans vos espaces de travail Slack.", category: "messaging", auth: "oauth" },
  { toolkit: "discord", label: "Discord", description: "Messages et annonces dans vos serveurs Discord.", category: "messaging", auth: "api_key" },
  // ---- Réseaux sociaux ----
  { toolkit: "linkedin", label: "LinkedIn", description: "Publication de posts et gestion de la présence professionnelle.", category: "social", auth: "oauth" },
  { toolkit: "x", label: "X (Twitter)", description: "Publication de tweets et suivi de l'audience.", category: "social", auth: "oauth" },
  { toolkit: "instagram", label: "Instagram", description: "Publication de contenus visuels et stories.", category: "social", auth: "oauth" },
  { toolkit: "facebook", label: "Facebook Pages", description: "Publications sur les pages Facebook de votre marque.", category: "social", auth: "oauth" },
  { toolkit: "reddit", label: "Reddit", description: "Publications et interactions communautaires Reddit.", category: "social", auth: "oauth" },
  { toolkit: "youtube", label: "YouTube", description: "Publication de vidéos et gestion des métadonnées.", category: "social", auth: "oauth" },
  // ---- Email & calendrier ----
  { toolkit: "gmail", label: "Gmail", description: "Lecture et envoi d'emails depuis une boîte Gmail autorisée.", category: "email_calendar", auth: "oauth" },
  { toolkit: "googlecalendar", label: "Google Agenda", description: "Consultation des disponibilités et création d'événements.", category: "email_calendar", auth: "oauth" },
  { toolkit: "outlook", label: "Outlook Email", description: "Lecture et envoi d'emails via Microsoft Outlook.", category: "email_calendar", auth: "oauth" },
  // ---- CRM ----
  { toolkit: "hubspot", label: "HubSpot", description: "Contacts, deals et pipeline commercial enrichis par vos agents.", category: "crm", auth: "oauth" },
  { toolkit: "pipedrive", label: "Pipedrive", description: "Prospection et mise à jour automatisée du pipeline.", category: "crm", auth: "api_key" },
  { toolkit: "salesforce", label: "Salesforce", description: "Synchronisation CRM Salesforce (leads, comptes, opportunités).", category: "crm", auth: "oauth" },
  // ---- E-commerce & paiements ----
  { toolkit: "stripe", label: "Stripe", description: "Factures, clients et paiements Stripe.", category: "ecommerce", auth: "api_key" },
  { toolkit: "shopify", label: "Shopify", description: "Commandes, produits et clients de votre boutique Shopify.", category: "ecommerce", auth: "api_key" },
  // ---- Développement ----
  { toolkit: "github", label: "GitHub", description: "Dépôts, issues et pull requests GitHub.", category: "developer", auth: "oauth" },
  { toolkit: "jira", label: "Jira", description: "Tickets et suivi de projets Jira.", category: "developer", auth: "oauth" },
  // ---- Connaissances & données ----
  { toolkit: "googledrive", label: "Google Drive", description: "Synchronisation de fichiers Drive vers la mémoire Gen3ia.", category: "knowledge", auth: "oauth" },
  { toolkit: "confluence", label: "Confluence", description: "Synchronisation de votre base de connaissances Confluence.", category: "knowledge", auth: "oauth" },
  { toolkit: "airtable", label: "Airtable", description: "Lecture et écriture dans vos bases Airtable.", category: "data", auth: "api_key" },
  { toolkit: "postgres", label: "PostgreSQL", description: "Requêtes en lecture sur vos bases PostgreSQL externes.", category: "data", auth: "api_key" },
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
  if (!CATALOG_INDEX.has(normalized)) throw new Error(`Toolkit "${normalized}" is not available in the Gen3ia connections catalog.`);
  return normalized;
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
