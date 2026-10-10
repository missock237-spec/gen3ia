import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { computeWakeAtMs, isScheduleActive, type AgentSchedule } from "@/lib/agents/scheduler";

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

// ─── Task 102-b — Réveil indexé wakeAtMs (quota Firestore) ───
// AVANT : chaque tick (5 min, 288/jour) lisait jusqu'à 500 plannings pour
// n'en exécuter que quelques-uns — jusqu'à ~144 000 lectures/jour.
// APRÈS : chaque doc porte wakeAtMs (min des réveils pertinents) et le
// balayage indexé ne lit QUE les plannings réellement dus.
describe("réveil indexé wakeAtMs (Task 102-b)", () => {
  it("planning cron actif : réveil = prochaine occurrence (créneau serveur UTC)", () => {
    // Lundi 2026-09-14 10:00 UTC, dans la fenêtre → prochaine occurrence =
    // mardi 08:00. NB : nextOccurrence construit les créneaux en heure
    // SERVEUR (comportement existant du dépôt) ; sandbox/CI/Vercel = UTC.
    const now = new Date("2026-09-14T10:00:00.000Z").getTime();
    expect(computeWakeAtMs(base, now)).toBe(new Date("2026-09-15T08:00:00.000Z").getTime());
  });

  it("planning désactivé : aucun réveil (ne doit JAMAIS apparaître dans le balayage)", () => {
    const now = new Date("2026-09-14T10:00:00.000Z").getTime();
    expect(computeWakeAtMs({ ...base, enabled: false }, now)).toBeUndefined();
  });

  it("one-shot non consommé : réveil = runAtMs ; consommé : aucun réveil", () => {
    const now = new Date("2026-09-14T09:00:00.000Z").getTime();
    const runAtMs = new Date("2026-09-14T10:00:00.000Z").getTime();
    const oneShot: AgentSchedule = {
      ...base,
      daysOfWeek: undefined,
      startTime: undefined,
      endTime: undefined,
      runAtMs,
    };
    expect(computeWakeAtMs(oneShot, now)).toBe(runAtMs);
    expect(
      computeWakeAtMs({ ...oneShot, lastTriggeredSlot: `oneshot:${runAtMs}` }, now),
    ).toBeUndefined();
  });

  it("relance différée : réveil = min(prochaine occurrence, notBeforeMs)", () => {
    const now = new Date("2026-09-14T10:00:00.000Z").getTime();
    const notBeforeMs = new Date("2026-09-14T11:30:00.000Z").getTime(); // avant mardi 07:00 UTC
    expect(
      computeWakeAtMs({ ...base, retryState: { attempt: 2, notBeforeMs } }, now),
    ).toBe(notBeforeMs);
  });

  it("veille : source jamais sondée = dû immédiatement ; sondée = +10 min", () => {
    const now = new Date("2026-09-14T10:00:00.000Z").getTime();
    const watcher: AgentSchedule = {
      ...base,
      daysOfWeek: undefined,
      startTime: undefined,
      endTime: undefined,
      watchSources: [{ kind: "rss", url: "https://exemple.fr/feed.xml" }],
    };
    expect(computeWakeAtMs(watcher, now)).toBe(now);
    const checked = computeWakeAtMs(
      {
        ...watcher,
        watchSources: [{ kind: "rss", url: "https://exemple.fr/feed.xml", lastCheckedAt: "2026-09-14T09:57:00.000Z" }],
      },
      now,
    );
    expect(checked).toBe(new Date("2026-09-14T09:57:00.000Z").getTime() + 10 * 60 * 1000);
  });

  // ─── Gardes structurels (convention du dépôt) : le contenu SOURCE doit ───
  // ─── conserver le balayage indexé + ses replis, sinon régression quota ───
  const source = readFileSync(path.join(import.meta.dirname, "scheduler.ts"), "utf8");

  it("garde : le balayage indexé where(wakeAtMs<=now)+orderBy+limit(200) est présent", () => {
    expect(source).toContain('where("wakeAtMs", "<=", nowMs)');
    expect(source).toContain('orderBy("wakeAtMs")');
    expect(source).toContain("limit(200)");
  });

  it("garde : le repli legacy complet et son throttle 10 min restent en place", () => {
    expect(source).toContain('where("enabled", "==", true).limit(500)');
    expect(source).toContain("LEGACY_SCAN_INTERVAL_MS = 10 * 60 * 1000");
    expect(source).toContain("lastLegacyScanAtMs");
    expect(source).toContain("WAKE_REPAIR_TOLERANCE_MS");
  });

  it("garde : la réparation wakeAtMs est bornée (batchs, merge, delete sur désarmement)", () => {
    expect(source).toContain("async function repairWakeFields");
    expect(source).toContain("adminDb.batch()");
    expect(source).toContain("wakeAtMs: FieldValue.delete()");
  });
});

// ─── FIX A5 — exécution planifiée outillée et LISIBLE (source contract) ───
// L'exécution planifiée tombait « completed » sans exécuter les outils du
// plan (policy absente → « Tool not allowed ») et sans AUCUNE sortie visible
// (notification sans contenu, run sans livrables). Le contrat ci-dessous
// verrouille les trois briques du correctif au niveau source (même motif
// que les gardes d'origine de lib/queue/origin.test.ts).
describe("runSchedule — policy dérivée du plan + livrables (fix A5)", () => {
  const source = readFileSync(path.resolve(__dirname, "scheduler.ts"), "utf8");

  it("le runtime de runSchedule reçoit la policy DÉRIVÉE DU PLAN (outils autorisés)", () => {
    expect(source).toMatch(/policy:\s*buildPlanExecutionPolicy\(\{ \.\.\.plan, executionId, objective \}\)/);
  });

  it("les livrables réels sont extraits des sorties et persistés sur le run", () => {
    expect(source).toMatch(/const deliverables = extractDeliverables\(state\.plan, state\.outputs \?\? \{\}\)/);
    expect(source).toMatch(/\{ deliverables, outputPreview \}/);
    expect(source).toMatch(/\.\.\.\(details\.deliverables && details\.deliverables\.length > 0 \? \{ deliverables: details\.deliverables \} : \{\}\)/);
  });

  it("l'extrait textuel du résultat est embarqué dans la notification (fini la boîte noire)", () => {
    expect(source).toMatch(/\.\.\.\(details\.outputPreview \? \{ outputPreview: details\.outputPreview \} : \{\}\)/);
  });

  it("le type ScheduleRun expose la sortie et les livrables au client", () => {
    expect(source).toMatch(/outputPreview\?: string;/);
    expect(source).toMatch(/deliverables\?: MissionDeliverable\[\];/);
  });
});
