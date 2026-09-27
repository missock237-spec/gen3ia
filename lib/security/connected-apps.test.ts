import { beforeEach, describe, expect, it, vi } from "vitest";

import { NEVER_BYPASSED_TOOLS, resetConnectedAppsCache, toolkitFromUrlHost } from "./connected-apps";

vi.mock("@/lib/integrations/composio/connections", () => ({
  listHubConnections: vi.fn(),
}));

import { listHubConnections } from "@/lib/integrations/composio/connections";
import { isExternalAppConnected } from "./connected-apps";

const listHubConnectionsMock = vi.mocked(listHubConnections);

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
