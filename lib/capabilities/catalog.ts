import "server-only";

import { GEN3IA_TOOLS } from "@/lib/tools/registry";
import { getInstalledExtensionCapabilities } from "@/lib/extensions/agent-bridge";
import { listEnabledCustomApis } from "@/lib/integrations/custom-apis/repository";
import { listUserServers } from "@/lib/integrations/mcp/service";

/**
 * CATALOGUE UNIFIÉ DE CAPACITÉS (concept post-SaaS #5 « AI Operating
 * System ») : la VUE UNIQUE de tout ce qu'un principal (utilisateur /
 * organisation) peut faire exécuter par ses agents Gen3ia. Les applications
 * deviennent des CAPACITÉS du système — outils natifs, skills, extensions
 * installées (marketplace), APIs personnelles, serveurs MCP, équipes
 * d'agents — agrégées sous un schéma commun, avec leur risque et leur
 * permission de niveau d'exécution.
 *
 * Lecture pure : ce catalogue ne modifie AUCUN chemin d'exécution existant
 * (les politiques de sécurité restent la source de vérité) ; il donne aux
 * clients (UI, SDK, planners) une seule liste cohérente et intègre.
 */

export type CapabilityKind = "tool" | "extension" | "custom_api" | "mcp_server" | "network";

export interface CapabilityEntry {
  /** Identifiant d'appel réel (toolName, ou id de ressource pour les kinds non-outils). */
  id: string;
  kind: CapabilityKind;
  name: string;
  description: string;
  /** Risque porté par la définition de sécurité (undefined pour les ressources). */
  risk?: string;
  sideEffect?: boolean;
  /** Permission requise au niveau politique d'exécution (outils natifs). */
  permission?: string;
  source: string;
}

export interface CapabilityCatalog {
  principal: { userId: string };
  totalCount: number;
  byKind: Record<CapabilityKind, number>;
  capabilities: CapabilityEntry[];
}

function nativeCapabilities(): CapabilityEntry[] {
  return GEN3IA_TOOLS.map((tool) => ({
    id: tool.name,
    kind: "tool" as const,
    name: tool.name,
    description: tool.description,
    risk: tool.risk,
    sideEffect: tool.sideEffect,
    permission: tool.permission,
    source: "gen3ia",
  }));
}

function extensionCapabilities(installed: Awaited<ReturnType<typeof getInstalledExtensionCapabilities>>): CapabilityEntry[] {
  return installed.tools.map((tool) => ({
    id: tool.toolName,
    kind: "extension" as const,
    name: tool.name,
    description: tool.description,
    sideEffect: true,
    source: `extension:${tool.extensionId}`,
  }));
}

async function customApiCapabilities(userId: string): Promise<CapabilityEntry[]> {
  try {
    const apis = await listEnabledCustomApis(userId);
    return apis.map((api) => ({
      id: api.id,
      kind: "custom_api" as const,
      name: api.name,
      description: api.description?.trim() || `API personnelle (${api.baseUrl.slice(0, 80)})`,
      sideEffect: false,
      source: "custom_api",
    }));
  } catch {
    // Une panne de lecture n'assemble jamais un catalogue mensonger — la
    // catégorie est simplement absente (le reste du catalogue reste juste).
    return [];
  }
}

async function mcpCapabilities(userId: string): Promise<CapabilityEntry[]> {
  try {
    const servers = await listUserServers(userId);
    return servers
      .filter((server) => server.enabled)
      .map((server) => ({
        id: server.id,
        kind: "mcp_server" as const,
        name: server.name,
        description: server.tools.length > 0
          ? `${server.tools.length} outil(s) MCP : ${server.tools.slice(0, 5).map((tool) => tool.name).join(", ")}${server.tools.length > 5 ? "…" : ""}`
          : "Serveur MCP connecté (outils non synchronisés)",
        sideEffect: true,
        source: `mcp:${server.id}`,
      }));
  } catch {
    return [];
  }
}

async function networkCapabilities(userId: string): Promise<CapabilityEntry[]> {
  try {
    const { listNetworks } = await import("@/lib/agents/networks/repository");
    const networks = await listNetworks(userId, { includeArchived: false });
    return networks.map((network) => ({
      id: network.id,
      kind: "network" as const,
      name: `Équipe ${network.name}`,
      description: `${network.members.length} agent(s) — topologie ${network.topology}${network.coordinatorAgentId ? `, coordinateur ${network.coordinatorAgentId}` : ""}`,
      source: "agent_network",
    }));
  } catch {
    return [];
  }
}

/** Assemble le catalogue unifié du principal (jamais d'exception propagée). */
export async function listCapabilitiesForUser(userId: string): Promise<CapabilityCatalog> {
  const capabilities: CapabilityEntry[] = [...nativeCapabilities()];

  const [installed, customApis, mcps, networks] = await Promise.all([
    getInstalledExtensionCapabilities(userId).catch(() => ({ tools: [], skills: [], workflows: [] })),
    customApiCapabilities(userId),
    mcpCapabilities(userId),
    networkCapabilities(userId),
  ]);

  capabilities.push(
    ...extensionCapabilities(installed),
    ...customApis,
    ...mcps,
    ...networks,
  );

  const byKind = capabilities.reduce<Record<CapabilityKind, number>>(
    (acc, entry) => {
      acc[entry.kind] += 1;
      return acc;
    },
    { tool: 0, extension: 0, custom_api: 0, mcp_server: 0, network: 0 },
  );

  return {
    principal: { userId },
    totalCount: capabilities.length,
    byKind,
    capabilities,
  };
}
