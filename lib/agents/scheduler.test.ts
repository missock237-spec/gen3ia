import { describe, expect, it } from "vitest";

import { isScheduleActive, type AgentSchedule } from "@/lib/agents/scheduler";

const base: AgentSchedule = {
  id: "s1",
  userId: "u1",
  agentId: "a1",
  name: "Test",
  objective: "Run scheduled agent",
  timezone: "Africa/Douala",
  daysOfWeek: [1, 2, 3, 4, 5],
  startTime: "08:00",
  endTime: "18:00",
  intervalMinutes: 0,
  enabled: true,
};

describe("agent scheduler", () => {
  // Africa/Douala = UTC+1 : 08:00-18:00 local correspond a 07:00-17:00 UTC.
  it("activates inside the configured window and selected day", () => {
    expect(isScheduleActive(base, new Date("2026-09-14T10:00:00.000Z"))).toBe(true);
    expect(isScheduleActive(base, new Date("2026-09-14T16:59:00.000Z"))).toBe(true);
    expect(isScheduleActive(base, new Date("2026-09-14T17:00:00.000Z"))).toBe(false);
  });

  it("does not activate on an unselected day", () => {
    expect(isScheduleActive(base, new Date("2026-09-13T10:00:00.000Z"))).toBe(false);
  });

  // Fenetre 22:00-06:00 local Douala = 21:00-05:00 UTC (chevauche minuit).
  it("supports windows crossing midnight", () => {
    const overnight = { ...base, startTime: "22:00", endTime: "06:00" };
    expect(isScheduleActive(overnight, new Date("2026-09-14T20:59:00.000Z"))).toBe(false);
    expect(isScheduleActive(overnight, new Date("2026-09-14T21:00:00.000Z"))).toBe(true);
    expect(isScheduleActive(overnight, new Date("2026-09-14T23:00:00.000Z"))).toBe(true);
    expect(isScheduleActive(overnight, new Date("2026-09-15T03:00:00.000Z"))).toBe(true);
    expect(isScheduleActive(overnight, new Date("2026-09-15T05:00:00.000Z"))).toBe(false);
  });

  it("treats equal start and end as a full-day window", () => {
    const allDay = { ...base, startTime: "00:00", endTime: "00:00" };
    expect(isScheduleActive(allDay, new Date("2026-09-14T23:59:00.000Z"))).toBe(true);
  });

  // ─── ONE-SHOT (runAtMs) : actif à l'échéance, sans fenêtre cron ───
  it("one-shot : actif dès l'échéance même sans fenêtre, avant : inactif", () => {
    const oneShot: AgentSchedule = {
      ...base,
      daysOfWeek: undefined,
      startTime: undefined,
      endTime: undefined,
      runAtMs: new Date("2026-09-14T10:00:00.000Z").getTime(),
    };
    expect(isScheduleActive(oneShot, new Date("2026-09-14T09:59:00.000Z"))).toBe(false);
    expect(isScheduleActive(oneShot, new Date("2026-09-14T10:00:00.000Z"))).toBe(true);
    expect(isScheduleActive(oneShot, new Date("2026-09-15T10:00:00.000Z"))).toBe(true);
    // Un one-shot désactivé ne se déclenche pas (auto-désarmement).
    expect(isScheduleActive({ ...oneShot, enabled: false }, new Date("2026-09-15T10:00:00.000Z"))).toBe(false);
  });

  it("one-shot coexiste avec la fenêtre hebdo : l'échéance force l'activation hors fenêtre", () => {
    const both: AgentSchedule = {
      ...base,
      runAtMs: new Date("2026-09-13T10:00:00.000Z").getTime(), // dimanche, hors fenêtre
    };
    expect(isScheduleActive(both, new Date("2026-09-13T12:00:00.000Z"))).toBe(true);
  });
});
