import { beforeEach, describe, expect, it, vi } from "vitest";

import { NEVER_BYPASSED_TOOLS, resetConnectedAppsCache, toolkitFromUrlHost } from "./connected-apps";

vi.mock("@/lib/integrations/composio/connections", () => ({
  listHubConnections: vi.fn(),
}));

vi.mock("@/lib/integrations/mcp/service", () => ({
  listUserServers: vi.fn(),
}));

import { listUserServers } from "@/lib/integrations/mcp/service";

import { listHubConnections } from "@/lib/integrations/composio/connections";
import { isExternalAppConnected } from "./connected-apps";

const listHubConnectionsMock = vi.mocked(listHubConnections);
const listUserServersMock = vi.mocked(listUserServers);

describe("toolkitFromUrlHost", () => {
  it("résout les hôtes d'API connus", () => {
    expect(toolkitFromUrlHost("api.github.com")).toBe("github");
    expect(toolkitFromUrlHost("api.notion.com")).toBe("notion");
    expect(toolkitFromUrlHost("api.stripe.com")).toBe("stripe");
    expect(toolkitFromUrlHost("sheets.googleapis.com")).toBe("googlesheets");
  });

  it("résout par segment générique (api.calendly.com → calendly)", () => {
    expect(toolkitFromUrlHost("api.calendly.com")).toBe("calendly");
    expect(toolkitFromUrlHost("api.trello.com")).toBe("trello");
  });

  it("rejette un hôte vide", () => {
    expect(toolkitFromUrlHost("   ")).toBeNull();
  });
});

describe("isExternalAppConnected — approbation conditionnelle", () => {
  beforeEach(() => {
    resetConnectedAppsCache();
    listHubConnectionsMock.mockReset();
  });

  it("true quand l'app ciblée par l'URL est connectée (statut ACTIVE)", async () => {
    listHubConnectionsMock.mockResolvedValue([
      { toolkit: "github", label: "GitHub", status: "ACTIVE", connectionId: "c1" },
    ] as never);
    const connected = await isExternalAppConnected("user-1", "web.api.write", {
      url: "https://api.github.com/repos/user/repo/issues",
      method: "POST",
    });
    expect(connected).toBe(true);
  });

  it("false quand l'app n'est pas connectée → l'approbation reste requise", async () => {
    listHubConnectionsMock.mockResolvedValue([]);
    const connected = await isExternalAppConnected("user-1", "web.api.write", {
      url: "https://api.notion.com/v1/pages",
      method: "PATCH",
    });
    expect(connected).toBe(false);
  });

  it("false pour un statut non actif (app non connectée réellement)", async () => {
    listHubConnectionsMock.mockResolvedValue([
      { toolkit: "notion", label: "Notion", status: "REVOKED", connectionId: "c2" },
    ] as never);
    const connected = await isExternalAppConnected("user-1", "web.api.write", {
      url: "https://api.notion.com/v1/pages",
    });
    expect(connected).toBe(false);
  });

  it("composio.execute résout par toolkit explicite", async () => {
    listHubConnectionsMock.mockResolvedValue([
      { toolkit: "slack", label: "Slack", status: "ACTIVE", connectionId: "c3" },
    ] as never);
    expect(await isExternalAppConnected("user-1", "composio.execute", { toolkit: "slack", action: "send_message" })).toBe(true);
  });

  it("plancher de sécurité : ads.publish / file.delete / phone.call jamais contournés", async () => {
    listHubConnectionsMock.mockResolvedValue([
      { toolkit: "google_ads", label: "Ads", status: "ACTIVE", connectionId: "c4" },
    ] as never);
    for (const tool of NEVER_BYPASSED_TOOLS) {
      expect(await isExternalAppConnected("user-1", tool, { url: "https://api.github.com/x" })).toBe(false);
    }
  });

  it("false sans URL résoluble (dans le doute, approbation)", async () => {
    expect(await isExternalAppConnected("user-1", "web.api.write", {})).toBe(false);
  });

  it("met en cache les connexions (un seul appel Composio par fenêtre TTL)", async () => {
    listHubConnectionsMock.mockResolvedValue([
      { toolkit: "github", label: "GitHub", status: "ACTIVE", connectionId: "c5" },
    ] as never);
    await isExternalAppConnected("user-1", "web.api.write", { url: "https://api.github.com/a" });
    await isExternalAppConnected("user-1", "web.api.write", { url: "https://github.com/b" });
    expect(listHubConnectionsMock).toHaveBeenCalledTimes(1);
  });
});

describe("isExternalAppConnected — mcp.call (Task 143 : connecté = agir)", () => {
  beforeEach(() => {
    resetConnectedAppsCache();
    listHubConnectionsMock.mockReset();
    listUserServersMock.mockReset();
  });

  it("true quand le serveur MCP désigné est actif et outillé", async () => {
    listUserServersMock.mockResolvedValue([
      { id: "srv-1", name: "Drive", url: "https://mcp.exemple.com", enabled: true, tools: [{ name: "search", description: "" }] },
      { id: "srv-2", name: "Vide", url: "https://mcp2.exemple.com", enabled: true, tools: [] },
      { id: "srv-3", name: "Off", url: "https://mcp3.exemple.com", enabled: false, tools: [{ name: "x", description: "" }] },
    ] as never);
    expect(await isExternalAppConnected("user-1", "mcp.call", { serverId: "srv-1", tool: "search" })).toBe(true);
  });

  it("false quand le serveur est désactivé, vide ou inconnu", async () => {
    listUserServersMock.mockResolvedValue([
      { id: "srv-2", name: "Vide", url: "https://mcp2.exemple.com", enabled: true, tools: [] },
      { id: "srv-3", name: "Off", url: "https://mcp3.exemple.com", enabled: false, tools: [{ name: "x", description: "" }] },
    ] as never);
    expect(await isExternalAppConnected("user-1", "mcp.call", { serverId: "srv-2", tool: "t" })).toBe(false);
    expect(await isExternalAppConnected("user-1", "mcp.call", { serverId: "srv-3", tool: "t" })).toBe(false);
    expect(await isExternalAppConnected("user-1", "mcp.call", { serverId: "srv-inconnu", tool: "t" })).toBe(false);
  });

  it("false sans serverId résoluble (approbation conservée)", async () => {
    listUserServersMock.mockResolvedValue([] as never);
    expect(await isExternalAppConnected("user-1", "mcp.call", {})).toBe(false);
    expect(await isExternalAppConnected("user-1", "mcp.call", { serverId: "  ", tool: "t" })).toBe(false);
  });

  it("panne de lecture Firestore → false (approbation conservée)", async () => {
    listUserServersMock.mockRejectedValue(new Error("Firestore down"));
    expect(await isExternalAppConnected("user-1", "mcp.call", { serverId: "srv-1", tool: "search" })).toBe(false);
  });
});
