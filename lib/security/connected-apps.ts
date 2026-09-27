import { listHubConnections } from "@/lib/integrations/composio/connections";

/**
 * Apps externes connectées — base de la règle d'approbation conditionnelle
 * (demande explicite utilisateur) :
 *
 *   « Une approbation ne doit avoir lieu UNIQUEMENT si l'app externe que
 *    l'agent appelle (l'API) a un statut NON connecté ; si l'agent est bien
 *    connecté, il doit juste agir sans demander une approbation. »
 *
 * Concrètement : quand l'agent doit effectuer une action externe
 * (web.api.write, composio.execute, social.publish, messaging.send,
 * github.create_repository…) et que l'application cible est DÉJÀ CONNECTÉE
 * par l'utilisateur (statut ACTIVE), l'action s'exécute directement —
 * sans carte de validation. Si l'app n'est pas connectée (ou inconnue),
 * l'approbation humaine reste requise comme aujourd'hui.
 *
 * Plancher de sécurité invariant (jamais contourné) : risque critical
 * (ads.publish, file.delete) et phone.call passent TOUJOURS par l'humain.
 */

/** Correspondance hôte d'API → toolkit Composio (les cas connus). */
const HOST_TOOLKIT_HINTS: ReadonlyArray<{ host: RegExp; toolkit: string }> = [
  { host: /(^|\.)api\.github\.com$/i, toolkit: "github" },
  { host: /(^|\.)github\.com$/i, toolkit: "github" },
  { host: /(^|\.)api\.notion\.com$/i, toolkit: "notion" },
  { host: /(^|\.)notion\.com$/i, toolkit: "notion" },
  { host: /(^|\.)slack\.com$/i, toolkit: "slack" },
  { host: /(^|\.)api\.hubspot\.com$/i, toolkit: "hubspot" },
  { host: /(^|\.)hubspot\.com$/i, toolkit: "hubspot" },
  { host: /(^|\.)api\.salesforce\.com$/i, toolkit: "salesforce" },
  { host: /(^|\.)salesforce\.com$/i, toolkit: "salesforce" },
  { host: /(^|\.)api\.shopify\.com$/i, toolkit: "shopify" },
  { host: /(^|\.)myshopify\.com$/i, toolkit: "shopify" },
  { host: /(^|\.)api\.stripe\.com$/i, toolkit: "stripe" },
  { host: /(^|\.)stripe\.com$/i, toolkit: "stripe" },
  { host: /(^|\.)api\.airtable\.com$/i, toolkit: "airtable" },
  { host: /(^|\.)airtable\.com$/i, toolkit: "airtable" },
  { host: /(^|\.)sheets\.googleapis\.com$/i, toolkit: "googlesheets" },
  { host: /(^|\.)calendar\.googleapis\.com$/i, toolkit: "googlecalendar" },
  { host: /(^|\.)googleapis\.com$/i, toolkit: "googledrive" },
  { host: /(^|\.)gmail\.com$/i, toolkit: "gmail" },
  { host: /(^|\.)api\.telegram\.org$/i, toolkit: "telegram" },
  { host: /(^|\.)telegram\.org$/i, toolkit: "telegram" },
  { host: /(^|\.)graph\.facebook\.com$/i, toolkit: "facebook" },
  { host: /(^|\.)facebook\.com$/i, toolkit: "facebook" },
  { host: /(^|\.)instagram\.com$/i, toolkit: "instagram" },
  { host: /(^|\.)linkedin\.com$/i, toolkit: "linkedin" },
  { host: /(^|\.)api\.twitter\.com$/i, toolkit: "x" },
  { host: /(^|\.)x\.com$/i, toolkit: "x" },
  { host: /(^|\.)twitter\.com$/i, toolkit: "x" },
  { host: /(^|\.)youtube\.com$/i, toolkit: "youtube" },
  { host: /(^|\.)whatsapp\.com$/i, toolkit: "whatsapp" },
];

/** Outils dont l'app cible est résoluble depuis l'input (URL ou toolkit). */
const CONNECTION_AWARE_TOOLS = new Set([
  "web.api.write",
  "composio.execute",
  "social.publish",
  "messaging.send",
  "github.create_repository",
]);

/** Actions critiques : l'humain décide toujours, app connectée ou non. */
export const NEVER_BYPASSED_TOOLS = new Set(["ads.publish", "file.delete", "phone.call"]);

/** Résout le toolkit Composio correspondant à un hôte d'API. */
export function toolkitFromUrlHost(host: string): string | null {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return null;
  for (const hint of HOST_TOOLKIT_HINTS) {
    if (hint.host.test(normalized)) return hint.toolkit;
  }
  // Repli générique : un segment significatif de l'hôte porte le nom du
  // toolkit (ex. api.calendly.com → calendly, api.trello.com → trello).
  const segments = normalized.replace(/^api\d?\./, "").split(".").filter(Boolean);
  for (const segment of segments.slice(0, 2)) {
    if (segment.length >= 3 && /^[a-z0-9_]+$/.test(segment)) return segment;
  }
  return null;
}

/** Extrait l'URL désignée par l'agent dans l'input d'un outil API. */
export function extractTargetUrl(input: Record<string, unknown>): string | null {
  const url = input.url;
  if (typeof url === "string" && /^https?:\/\//i.test(url.trim())) return url.trim();
  return null;
}

/* ------------------------------------------------------------------ */
/* Cache TTL court : éviter un appel Composio par étape du plan        */
/* ------------------------------------------------------------------ */

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; toolkits: Set<string> }>();

function readCache(userId: string): Set<string> | null {
  const hit = cache.get(userId);
  if (!hit || Date.now() - hit.at > CACHE_TTL_MS) return null;
  return hit.toolkits;
}

function writeCache(userId: string, toolkits: Set<string>): void {
  cache.set(userId, { at: Date.now(), toolkits });
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

/** Vide le cache (tests). */
export function resetConnectedAppsCache(): void {
  cache.clear();
}

/**
 * Toolkits ACTIVEMENT connectés par l'utilisateur (statut ACTIVE, non
 * désactivé). Échec réseau → ensemble vide (approbation conservée : en cas
 * de doute, on demande).
 */
export async function listConnectedToolkits(userId: string): Promise<Set<string>> {
  if (!userId?.trim()) return new Set();
  const cached = readCache(userId);
  if (cached) return cached;
  const toolkits = new Set<string>();
  try {
    const connections = await listHubConnections(userId);
    for (const connection of connections) {
      const status = String(connection.status ?? "").toUpperCase();
      if (status === "ACTIVE" || status === "CONNECTED") toolkits.add(connection.toolkit.toLowerCase());
    }
  } catch {
    return new Set();
  }
  writeCache(userId, toolkits);
  return toolkits;
}

/**
 * L'app externe ciblée par cet appel d'outil est-elle connectée par
 * l'utilisateur ? `false` quand on ne sait pas résoudre la cible — dans le
 * doute, l'approbation humaine reste la règle.
 */
export async function isExternalAppConnected(
  userId: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  if (NEVER_BYPASSED_TOOLS.has(toolName)) return false;
  if (!CONNECTION_AWARE_TOOLS.has(toolName)) return false;

  let toolkit: string | null = null;
  if (toolName === "composio.execute") {
    const slug = typeof input.toolkit === "string" ? input.toolkit : typeof input.toolSlug === "string" ? input.toolSlug : "";
    toolkit = slug ? slug.trim().toLowerCase() : null;
  } else if (toolName === "github.create_repository") {
    toolkit = "github";
  } else if (toolName === "social.publish" || toolName === "messaging.send") {
    const platform = input.platform ?? input.channel ?? input.provider;
    toolkit = typeof platform === "string" ? platform.trim().toLowerCase() : null;
    if (toolkit === "whatsapp_business") toolkit = "whatsapp";
    if (toolkit === "x" || toolkit === "twitter") toolkit = "x";
  } else {
    const url = extractTargetUrl(input);
    if (!url) return false;
    try {
      toolkit = toolkitFromUrlHost(new URL(url).host);
    } catch {
      return false;
    }
  }

  if (!toolkit) return false;
  const connected = await listConnectedToolkits(userId);
  return connected.has(toolkit);
}
