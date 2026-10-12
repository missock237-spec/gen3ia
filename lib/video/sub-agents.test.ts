import { describe, expect, it } from "vitest";

import { runSubAgentWave, shouldDeploySubAgents } from "./sub-agents";

describe("Task 134 — orchestration des sous-agents vidéo", () => {
  it("exécute les items en vague parallèle bornée (ordre stable)", async () => {
    const items = [1, 2, 3, 4, 5, 6];
    let running = 0;
    let peak = 0;
    const wave = await runSubAgentWave("voice_sync", items, 2, async (item) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return item * 10;
    });
    expect(wave.parallelism).toBe(2);
    expect(peak).toBeLessThanOrEqual(2); // concurrence stricte
    expect(wave.fulfilled).toBe(6);
    expect(wave.outcomes.map((o) => (o.status === "fulfilled" ? o.value : null))).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it("isole les échecs : un sous-agent rejeté n'interrompt pas la vague", async () => {
    const items = ["a", "b", "c"];
    const wave = await runSubAgentWave("export_render", items, 3, async (item) => {
      if (item === "b") throw new Error("boom");
      return item.toUpperCase();
    });
    expect(wave.fulfilled).toBe(2);
    expect(wave.rejected).toBe(1);
    expect(wave.outcomes[1]?.status).toBe("rejected");
    expect(wave.outcomes[0]).toMatchObject({ status: "fulfilled", value: "A" });
  });

  it("consigne le résumé de vague via le canal de log", async () => {
    const logs: string[] = [];
    await runSubAgentWave("audio_preflight", [1, 2], 2, async () => undefined, {
      log: (message) => {
        logs.push(message);
      },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("préflight");
    expect(logs[0]).toContain("2/2");
  });

  it("respecte le budget temps via shouldStart (items reportés)", async () => {
    const items = [1, 2, 3];
    const wave = await runSubAgentWave("voice_sync", items, 3, async (item) => item, {
      shouldStart: (index) => index < 1,
    });
    expect(wave.fulfilled).toBe(1);
    expect(wave.skipped).toBe(2);
  });

  it("shouldDeploySubAgents n'active la vague qu'à partir de 2 items", () => {
    expect(shouldDeploySubAgents(1)).toBe(false);
    expect(shouldDeploySubAgents(2)).toBe(true);
    expect(shouldDeploySubAgents(12)).toBe(true);
  });

  it("borne la concurrence demandée à au plus le nombre d'items", async () => {
    const wave = await runSubAgentWave("voice_sync", [1], 99, async () => 42);
    expect(wave.parallelism).toBe(1);
  });
});
