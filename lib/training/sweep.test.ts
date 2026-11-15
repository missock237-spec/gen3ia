import { beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ */
/* Balayage global des tâches (cron) — recensement des utilisateurs    */
/* et agrégation best-effort des sweeps par utilisateur.               */
/*                                                                    */
/* Le listage R2 et l'orchestrateur sont mockés : on teste la LOGIQUE  */
/* (extraction des uid, plafonds, isolation des erreurs, propagation   */
/* d'une panne de stockage).                                           */
/* ------------------------------------------------------------------ */

vi.mock("@/lib/storage/user-data-store", () => ({
  listKeys: vi.fn(),
}));

vi.mock("./orchestrator", () => ({
  sweepUserJobs: vi.fn(),
}));

import { listKeys } from "@/lib/storage/user-data-store";
import { sweepUserJobs } from "./orchestrator";
import { listTrainingUserIds, sweepAllTrainingJobs } from "./sweep";

const mockedListKeys = vi.mocked(listKeys);
const mockedSweep = vi.mocked(sweepUserJobs);

function userKey(uid: string): { key: string; size: number; lastModified: string } {
  return { key: `fs/users/${uid}.json`, size: 128, lastModified: "2026-01-01T00:00:00.000Z" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSweep.mockResolvedValue({ dispatched: 0, refreshed: 0 });
});

describe("listTrainingUserIds", () => {
  it("extrait les uid depuis la collection r2fs users", async () => {
    mockedListKeys.mockResolvedValue([userKey("abc123"), userKey("def-456")]);
    await expect(listTrainingUserIds()).resolves.toEqual(["abc123", "def-456"]);
    expect(mockedListKeys).toHaveBeenCalledWith("fs/users/", { maxObjects: 1000 });
  });

  it("ignore les clés non conformes (sous-répertoires, espaces) et déduplique", async () => {
    mockedListKeys.mockResolvedValue([
      userKey("ok"),
      { key: "fs/users/sub/dir.json", size: 1, lastModified: "" },
      { key: "fs/users/avec espace.json", size: 1, lastModified: "" },
      { key: "fs/users/ok.json", size: 1, lastModified: "" },
    ]);
    await expect(listTrainingUserIds()).resolves.toEqual(["ok"]);
  });

  it("plafonne le nombre d'utilisateurs retournés", async () => {
    mockedListKeys.mockResolvedValue([userKey("a"), userKey("b"), userKey("c")]);
    await expect(listTrainingUserIds(2)).resolves.toEqual(["a", "b"]);
  });

  it("propage l'échec du listage (jamais de scan silencieux)", async () => {
    mockedListKeys.mockRejectedValue(new Error("R2 indisponible"));
    await expect(listTrainingUserIds()).rejects.toThrow("R2 indisponible");
  });
});

describe("sweepAllTrainingJobs", () => {
  it("agrège les résultats de chaque utilisateur", async () => {
    mockedListKeys.mockResolvedValue([userKey("u1"), userKey("u2")]);
    mockedSweep
      .mockResolvedValueOnce({ dispatched: 1, refreshed: 2 })
      .mockResolvedValueOnce({ dispatched: 3, refreshed: 4 });

    const result = await sweepAllTrainingJobs();

    expect(result).toEqual({ usersScanned: 2, dispatched: 4, refreshed: 6, failures: [] });
    expect(mockedSweep).toHaveBeenNthCalledWith(1, "u1");
    expect(mockedSweep).toHaveBeenNthCalledWith(2, "u2");
  });

  it("continue malgré l'échec d'un utilisateur et enregistre la cause", async () => {
    mockedListKeys.mockResolvedValue([userKey("u1"), userKey("u2"), userKey("u3")]);
    mockedSweep
      .mockRejectedValueOnce(new Error("projet illisible"))
      .mockResolvedValueOnce({ dispatched: 0, refreshed: 1 });

    const result = await sweepAllTrainingJobs();

    expect(result.usersScanned).toBe(3);
    expect(result.refreshed).toBe(1);
    expect(result.failures).toEqual(["u1: projet illisible"]);
    expect(mockedSweep).toHaveBeenCalledTimes(3);
  });

  it("retourne des compteurs nuls quand aucun utilisateur n'existe", async () => {
    mockedListKeys.mockResolvedValue([]);
    const result = await sweepAllTrainingJobs();
    expect(result).toEqual({ usersScanned: 0, dispatched: 0, refreshed: 0, failures: [] });
    expect(mockedSweep).not.toHaveBeenCalled();
  });
});
