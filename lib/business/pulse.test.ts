import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PULSE BUSINESS AUTONOME (concept #7 « Autonomous Business Cloud ») :
 * collecte fail-soft des KPIs réels (portefeuille, campagnes, écueils),
 * objectif construit hors LLM (faits réels, dépense interdite), enfilement
 * réel dans la file QStash, dry-run sans exécution, ledger des pulses.
 */

const runsDocAdd = vi.fn();
vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({ add: runsDocAdd })),
  },
}));

const getWalletMock = vi.fn();
vi.mock("@/lib/billing/wallet", () => ({
  getWallet: (...args: unknown[]) => getWalletMock(...args),
}));

const listCampaignsMock = vi.fn();
vi.mock("@/lib/ads/campaigns", () => ({
  listCampaigns: (...args: unknown[]) => listCampaignsMock(...args),
}));

const getEvolutionBriefMock = vi.fn();
vi.mock("@/lib/agents/evolution", () => ({
  getEvolutionBrief: (...args: unknown[]) => getEvolutionBriefMock(...args),
}));

const createQueuedMissionMock = vi.fn();
const missionQueueConfiguredMock = vi.fn();
const publishMissionTickMock = vi.fn();
vi.mock("@/lib/queue/mission-queue", () => ({
  createQueuedMission: (...args: unknown[]) => createQueuedMissionMock(...args),
}));
vi.mock("@/lib/queue/qstash", () => ({
  missionQueueConfigured: () => missionQueueConfiguredMock(),
  publishMissionTick: (...args: unknown[]) => publishMissionTickMock(...args),
}));

import { buildPulseObjective, collectBusinessKpis, runBusinessPulse } from "./pulse";

beforeEach(() => {
  getWalletMock.mockReset();
  listCampaignsMock.mockReset();
  getEvolutionBriefMock.mockReset();
  createQueuedMissionMock.mockReset();
  missionQueueConfiguredMock.mockReset();
  publishMissionTickMock.mockReset();
  runsDocAdd.mockReset();
  runsDocAdd.mockResolvedValue(undefined);
  getWalletMock.mockResolvedValue({ balanceMinor: 420_000, reservedMinor: 5_000, currency: "XAF" });
  listCampaignsMock.mockResolvedValue([]);
  getEvolutionBriefMock.mockResolvedValue({ text: "", clusters: [] });
  missionQueueConfiguredMock.mockReturnValue(true);
  createQueuedMissionMock.mockResolvedValue(undefined);
  publishMissionTickMock.mockResolvedValue({ messageId: "m1" });
});

describe("collecte des KPIs", () => {
  it("agrège portefeuille + campagnes actives/pause + écueils", async () => {
    listCampaignsMock.mockResolvedValue([
      { status: "active", dailyBudgetMinor: 500 },
      { status: "active", dailyBudgetMinor: 300 },
      { status: "paused", dailyBudgetMinor: 100 },
    ]);
    getEvolutionBriefMock.mockResolvedValue({
      text: "...",
      clusters: [
        { errorClass: "timeout", stepType: "tool", occurrences: 5, sample: "x" },
        { errorClass: "tool_missing", stepType: "tool", occurrences: 2, sample: "y" },
      ],
    });
    const kpis = await collectBusinessKpis("u1");
    expect(kpis.wallet?.balanceMinor).toBe(420_000);
    expect(kpis.ads).toEqual({ active: 2, paused: 1, totalDailyBudgetMinor: 800 });
    expect(kpis.topRisks).toEqual(["timeout (5×)", "tool_missing (2×)"]);
  });

  it("panne d'une source = catégorie absente (jamais d'invention)", async () => {
    getWalletMock.mockRejectedValue(new Error("down"));
    listCampaignsMock.mockRejectedValue(new Error("down"));
    const kpis = await collectBusinessKpis("u1");
    expect(kpis.wallet).toBeUndefined();
    expect(kpis.ads).toBeUndefined();
    expect(kpis.topRisks).toBeUndefined();
  });
});

describe("objectif du pulse", () => {
  it("les FAITS réels sont dans l'objectif ; la dépense y est explicitement interdite", () => {
    const objective = buildPulseObjective({
      wallet: { balanceMinor: 420_000, reservedMinor: 5_000, currency: "XAF" },
      ads: { active: 2, paused: 1, totalDailyBudgetMinor: 800 },
      topRisks: ["timeout (5×)"],
    });
    expect(objective).toContain("4200.00 XAF");
    expect(objective).toContain("2 campagne(s) active(s)");
    expect(objective).toContain("timeout (5×)");
    expect(objective.toLowerCase()).toContain("dépense");
  });

  it("aucun indicateur → objectif honnête (pas de chiffres inventés)", () => {
    const objective = buildPulseObjective({});
    expect(objective).toContain("Aucun indicateur disponible");
  });
});

describe("lancement du pulse", () => {
  it("dry-run : KPIs + objectif retournés, AUCUNE mission enfilée", async () => {
    const result = await runBusinessPulse({ userId: "u1", dryRun: true });
    expect(result.executed).toBe(false);
    expect(result.objective).toContain("PULSE BUSINESS");
    expect(createQueuedMissionMock).not.toHaveBeenCalled();
  });

  it("mission réellement enfilée (file configurée) + ledger", async () => {
    const result = await runBusinessPulse({ userId: "u1" });
    expect(result.executed).toBe(true);
    expect(result.runId).toBeTruthy();
    expect(result.statusUrl).toContain("/api/agents/runs/");
    const mission = createQueuedMissionMock.mock.calls[0][0];
    expect(mission.objective).toContain("PULSE BUSINESS");
    expect(mission.plan.steps[0].type).toBe("llm");
    expect(runsDocAdd).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", runId: result.runId }));
  });

  it("file non configurée → refus honnête (pas de mission fantôme)", async () => {
    missionQueueConfiguredMock.mockReturnValue(false);
    const result = await runBusinessPulse({ userId: "u1" });
    expect(result.executed).toBe(false);
    expect(result.reason).toContain("File d'attente");
    expect(createQueuedMissionMock).not.toHaveBeenCalled();
  });
});
