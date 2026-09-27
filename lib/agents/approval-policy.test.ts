import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/integrations/composio/connections", () => ({
  listHubConnections: vi.fn(),
}));

import { listHubConnections } from "@/lib/integrations/composio/connections";
import { selectApprovalRequiredSteps, stepRequiresHumanApproval } from "./approval-policy";
import { resetConnectedAppsCache } from "@/lib/security/connected-apps";

const listHubConnectionsMock = vi.mocked(listHubConnections);

const baseStep = {
  id: "step-1",
  type: "tool" as const,
  name: "Étape",
  description: "",
  status: "pending" as const,
  dependencies: [] as string[],
  input: {},
  skillIds: [] as string[],
  maxRetries: 2,
  timeoutMs: 60_000,
  sideEffect: true,
  requiresApproval: true,
};

describe("selectApprovalRequiredSteps — règle utilisateur (app connectée = action directe)", () => {
  beforeEach(() => {
    resetConnectedAppsCache();
    listHubConnectionsMock.mockReset();
    listHubConnectionsMock.mockResolvedValue([]);
  });

  it("ne demande AUCUNE approbation quand l'app externe est connectée", async () => {
    listHubConnectionsMock.mockResolvedValue([
      { toolkit: "notion", label: "Notion", status: "ACTIVE", connectionId: "c1" },
    ] as never);
    const steps = [
      { ...baseStep, toolName: "web.api.write", input: { url: "https://api.notion.com/v1/pages", method: "POST" } },
    ];
    const approvalSteps = await selectApprovalRequiredSteps("user-1", steps);
    expect(approvalSteps).toHaveLength(0);
  });

  it("demande l'approbation quand l'app externe est NON connectée", async () => {
    const steps = [
      { ...baseStep, toolName: "web.api.write", input: { url: "https://api.inconnue-exemple.com/v1/items", method: "POST" } },
    ];
    const approvalSteps = await selectApprovalRequiredSteps("user-1", steps);
    expect(approvalSteps).toHaveLength(1);
  });

  it("n'approbe jamais les actions purement internes (stockage, mémoire, automatisations)", async () => {
    const steps = [
      { ...baseStep, toolName: "file.create" },
      { ...baseStep, toolName: "artifact.create" },
      { ...baseStep, toolName: "memory.write" },
      { ...baseStep, toolName: "schedule.create" },
    ];
    const approvalSteps = await selectApprovalRequiredSteps("user-1", steps);
    expect(approvalSteps).toHaveLength(0);
  });

  it("préserve le plancher de sécurité (ads.publish, file.delete, phone.call)", async () => {
    listHubConnectionsMock.mockResolvedValue([
      { toolkit: "github", label: "GitHub", status: "ACTIVE", connectionId: "c2" },
    ] as never);
    const steps = [
      { ...baseStep, toolName: "ads.publish", input: {} },
      { ...baseStep, toolName: "file.delete", input: {} },
      { ...baseStep, toolName: "phone.call", input: {} },
    ];
    const approvalSteps = await selectApprovalRequiredSteps("user-1", steps);
    expect(approvalSteps.map((step) => step.toolName).sort()).toEqual(["ads.publish", "file.delete", "phone.call"]);
  });

  it("ignore les étapes sans effet de bord", async () => {
    const steps = [{ ...baseStep, toolName: "web.search", sideEffect: false, requiresApproval: false }];
    const approvalSteps = await selectApprovalRequiredSteps("user-1", steps);
    expect(approvalSteps).toHaveLength(0);
  });
});

describe("stepRequiresHumanApproval", () => {
  beforeEach(() => {
    resetConnectedAppsCache();
    listHubConnectionsMock.mockReset();
    listHubConnectionsMock.mockResolvedValue([]);
  });

  it("risque critical → toujours une approbation", async () => {
    expect(await stepRequiresHumanApproval("user-1", "ads.publish", {}, { risk: "critical" })).toBe(true);
  });

  it("app connectée → pas d'approbation", async () => {
    listHubConnectionsMock.mockResolvedValue([
      { toolkit: "github", label: "GitHub", status: "ACTIVE", connectionId: "c3" },
    ] as never);
    expect(await stepRequiresHumanApproval("user-1", "github.create_repository", {})).toBe(false);
  });

  it("app non connectée → approbation", async () => {
    expect(await stepRequiresHumanApproval("user-1", "github.create_repository", {})).toBe(true);
  });
});
