import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trainingMinutesUsedThisMonth } from "./quotas";

/* ------------------------------------------------------------------ */
/* Budget de minutes mensuel — calcul de la consommation réelle.        */
/* Les jobs jamais démarrés ne consomment RIEN (honnêteté spec §2).      */
/* ------------------------------------------------------------------ */

const listJsonMock = vi.fn().mockResolvedValue([]);
const listJobsMock = vi.fn().mockResolvedValue([]);

vi.mock("@/lib/storage/user-data-store", () => ({
  listJson: (...args: unknown[]) => listJsonMock(...args),
  listKeys: vi.fn().mockResolvedValue([]),
  userDir: (uid: string, ...segments: string[]) => `users/${uid}/${segments.join("/")}`,
  userKey: (uid: string, ...segments: string[]) => `users/${uid}/${segments.join("/")}.json`,
}));

vi.mock("@/lib/training/repository", () => ({
  listJobs: (...args: unknown[]) => listJobsMock(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

function jobFixture(overrides: Record<string, unknown>) {
  return {
    v: 1,
    id: "job-x",
    projectId: "p1",
    planId: "plan-x",
    ownerId: "user-1",
    status: "running",
    simulated: false,
    metrics: {},
    artifacts: [],
    events: [],
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("trainingMinutesUsedThisMonth", () => {
  it("additionne les durées réelles des jobs du mois (running = jusqu'à maintenant)", async () => {
    listJsonMock.mockResolvedValue([
      { id: "p1", status: "active", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    listJobsMock.mockResolvedValue([
      // Terminé : 30 min exactes (10:00 → 10:30).
      jobFixture({ status: "completed", startedAt: "2026-10-10T10:00:00.000Z", finishedAt: "2026-10-10T10:30:00.000Z" }),
      // En cours : démarré aujourd'hui 10:50 → maintenant simulé 12:00 = 70 min.
      jobFixture({ status: "running", startedAt: "2026-10-18T10:50:00.000Z", finishedAt: null }),
    ]);
    const minutes = await trainingMinutesUsedThisMonth("user-1");
    // 30 min (terminé) + 70 min (en cours jusqu'à l'heure simulée 12:00).
    expect(Math.round(minutes)).toBe(100);
  });

  it("ignore les jobs jamais démarrés et les jobs des mois précédents", async () => {
    listJsonMock.mockResolvedValue([
      { id: "p1", status: "active", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
    ]);
    listJobsMock.mockResolvedValue([
      // Jamais démarré (resté en file puis annulé) : 0 minute.
      jobFixture({ status: "cancelled", startedAt: null, finishedAt: "2026-10-11T00:00:00.000Z" }),
      // Démarré en septembre : hors du mois courant.
      jobFixture({ status: "completed", startedAt: "2026-09-30T23:00:00.000Z", finishedAt: "2026-09-30T23:40:00.000Z" }),
    ]);
    const minutes = await trainingMinutesUsedThisMonth("user-1");
    expect(minutes).toBe(0);
  });

  it("retourne 0 sans projets", async () => {
    listJsonMock.mockResolvedValue([]);
    await expect(trainingMinutesUsedThisMonth("user-1")).resolves.toBe(0);
  });
});
