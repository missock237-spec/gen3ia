import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CATALOGUE UNIFIÉ DE CAPACITÉS (concept #5 « AI Operating System ») :
 * outils natifs + extensions installées + APIs personnelles + serveurs MCP +
 * équipes d'agents agrégés sous un schéma commun — lecture pure, panne
 * partielle d'une source = catégorie absente (jamais de catalogue mensonger),
 * filtre par kind.
 */

vi.mock("@/lib/tools/registry", () => ({
  GEN3IA_TOOLS: [
    { name: "web.search", description: "Search the public web.", risk: "read", permission: "network.read", sideEffect: false },
    { name: "network.send_message", description: "Message d'équipe.", risk: "write", permission: "tool.write", sideEffect: true },
  ],
}));

const installedExtensionCapabilitiesMock = vi.fn();
vi.mock("@/lib/extensions/agent-bridge", () => ({
  getInstalledExtensionCapabilities: (...args: unknown[]) => installedExtensionCapabilitiesMock(...args),
}));

const listEnabledCustomApisMock = vi.fn();
vi.mock("@/lib/integrations/custom-apis/repository", () => ({
  listEnabledCustomApis: (...args: unknown[]) => listEnabledCustomApisMock(...args),
}));

const listUserServersMock = vi.fn();
vi.mock("@/lib/integrations/mcp/service", () => ({
  listUserServers: (...args: unknown[]) => listUserServersMock(...args),
}));

const listNetworksMock = vi.fn();
vi.mock("@/lib/agents/networks/repository", () => ({
  listNetworks: (...args: unknown[]) => listNetworksMock(...args),
}));

import { listCapabilitiesForUser } from "./catalog";

beforeEach(() => {
  installedExtensionCapabilitiesMock.mockReset();
  listEnabledCustomApisMock.mockReset();
  listUserServersMock.mockReset();
  listNetworksMock.mockReset();
});

describe("listCapabilitiesForUser", () => {
  it("agrège les cinq sources sous un schéma commun", async () => {
    installedExtensionCapabilitiesMock.mockResolvedValue({
      tools: [{ toolName: "ext.crm.create_contact", extensionId: "crm", toolId: "create_contact", name: "Créer contact", description: "CRM" }],
      skills: [],
      workflows: [],
    });
    listEnabledCustomApisMock.mockResolvedValue([{ id: "api-1", name: "ERP interne", baseUrl: "https://erp.exemple.com", description: "" }]);
    listUserServersMock.mockResolvedValue([
      { id: "mcp-1", name: "Google Drive", enabled: true, tools: [{ name: "gdrive.search", description: "search" }, { name: "gdrive.read", description: "read" }] },
      { id: "mcp-2", name: "Désactivé", enabled: false, tools: [] },
    ]);
    listNetworksMock.mockResolvedValue([
      { id: "net-1", name: "Marketing", topology: "coordinator", coordinatorAgentId: "a1", members: [{ agentId: "a1", role: "Coord" }, { agentId: "a2", role: "Rédac" }] },
    ]);

    const catalog = await listCapabilitiesForUser("u1");
    expect(catalog.totalCount).toBe(6); // 2 natifs + 1 extension + 1 api + 1 mcp actif + 1 équipe
    expect(catalog.byKind).toEqual({ tool: 2, extension: 1, custom_api: 1, mcp_server: 1, network: 1 });
    const ext = catalog.capabilities.find((entry) => entry.kind === "extension");
    expect(ext?.id).toBe("ext.crm.create_contact");
    expect(ext?.sideEffect).toBe(true);
    const mcp = catalog.capabilities.find((entry) => entry.kind === "mcp_server");
    expect(mcp?.description).toContain("2 outil(s)");
    const network = catalog.capabilities.find((entry) => entry.kind === "network");
    expect(network?.description).toContain("2 agent(s)");
  });

  it("panne partielle d'une source : catégorie absente, jamais de catalogue mensonger", async () => {
    installedExtensionCapabilitiesMock.mockRejectedValue(new Error("firestore down"));
    listEnabledCustomApisMock.mockRejectedValue(new Error("firestore down"));
    listUserServersMock.mockResolvedValue([]);
    listNetworksMock.mockRejectedValue(new Error("firestore down"));
    const catalog = await listCapabilitiesForUser("u1");
    expect(catalog.byKind.tool).toBe(2);
    expect(catalog.byKind.extension).toBe(0);
    expect(catalog.byKind.custom_api).toBe(0);
    expect(catalog.totalCount).toBe(2);
  });
});
