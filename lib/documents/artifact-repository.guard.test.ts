import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Garde quota du dépôt d'artefacts (Task 110-e).
 *
 * createArtifactRecord est l'écriture du LIVRABLE de mission (outil
 * artifact.create → storeArtifactBuffer, chemin runtime AgentRuntime). Sur
 * Firestore brut, sous quota quotidien épuisé, l'écriture pendaît SANS lever
 * (Task 97) : l'étape livrable pendait jusqu'à son timeout (120 s par
 * défaut) puis échouait — le travail de la mission était perdu pour
 * l'utilisateur. Contrat après fix : touches bornées (6 s) + disjoncteur via
 * le MÊME runFirestoreGuarded que la file de missions.
 */

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ create: mocks.create, get: mocks.get, delete: mocks.delete })),
    })),
  },
}));

const quotaError = () => Object.assign(new Error("Quota exceeded for quota group 'default'."), { code: 8 });

function openBreaker(): void {
  noteFirestoreQuotaError(quotaError());
  noteFirestoreQuotaError(quotaError());
  noteFirestoreQuotaError(quotaError());
}

beforeEach(() => {
  vi.useFakeTimers();
  resetQuotaGuardForTests();
  mocks.create.mockReset();
  mocks.get.mockReset();
  mocks.delete.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

import { getQuotaGuardStats, noteFirestoreQuotaError, resetQuotaGuardForTests } from "@/lib/db/quota-guard";
import {
  createArtifactRecord,
  getArtifactRecord,
  type ArtifactRecord,
} from "./artifact-repository";

const ARTIFACT: ArtifactRecord = {
  artifactId: "art-110e",
  ownerId: "user-1",
  executionId: "exec-110e",
  name: "rapport.pdf",
  mimeType: "application/pdf",
  size: 10,
  storageKey: "artifacts/user-1/art-110e/rapport.pdf",
  checksum: "abc",
  createdAt: 1,
};

async function outcomeWithinDeadline(pending: Promise<unknown>): Promise<string> {
  return Promise.race([
    pending.then(
      () => "resolved" as const,
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}` as const,
    ),
    vi.advanceTimersByTimeAsync(7_000).then(() => "timeout" as const),
  ]);
}

describe("createArtifactRecord sous garde (110-e)", () => {
  it("VERROU 110-e : disjoncteur ouvert → rejet immédiat, écriture JAMAIS émise", async () => {
    openBreaker();
    mocks.create.mockResolvedValue(undefined);
    await expect(createArtifactRecord(ARTIFACT)).rejects.toThrow("Firestore sous quota");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : écriture qui pend → rejet quota-classifié au délai (livrable plus jamais perdu dans une pendule)", async () => {
    mocks.create.mockImplementation(() => new Promise<void>(() => undefined)); // stall
    const outcome = await outcomeWithinDeadline(createArtifactRecord(ARTIFACT));
    expect(outcome).toMatch(/^rejected:/);
    expect(outcome).toContain("quota");
    expect(getQuotaGuardStats().state).toBe("open");
  });

  it("chemin nominal inchangé : artefact créé (régression)", async () => {
    mocks.create.mockResolvedValue(undefined);
    await expect(createArtifactRecord(ARTIFACT)).resolves.toEqual(ARTIFACT);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(getQuotaGuardStats().state).toBe("closed");
  });

  it("chemin nominal inchangé : lecture doc absent → null (régression)", async () => {
    mocks.get.mockResolvedValue({ exists: false });
    await expect(getArtifactRecord("art-110e")).resolves.toBeNull();
  });
});
