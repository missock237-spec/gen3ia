import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ipFromRequest,
  listTrainingAudit,
  recordTrainingAudit,
  type TrainingAuditEntry,
} from "./audit";

/* ------------------------------------------------------------------ */
/* Journal d'audit du Training Studio — enregistrement + lecture.        */
/* ------------------------------------------------------------------ */

const writeJsonMock = vi.fn().mockResolvedValue(undefined);
const listJsonMock = vi.fn().mockResolvedValue([]);

vi.mock("@/lib/storage/user-data-store", () => ({
  writeJson: (...args: unknown[]) => writeJsonMock(...args),
  listJson: (...args: unknown[]) => listJsonMock(...args),
  newUlid: vi.fn(() => `ULID${Math.floor(Math.random() * 1_000_000)}`),
  userDir: (uid: string, ...segments: string[]) => `users/${uid}/${segments.join("/")}`,
  userKey: (uid: string, ...segments: string[]) => `users/${uid}/${segments.join("/")}.json`,
}));

beforeEach(() => {
  vi.clearAllMocks();
  writeJsonMock.mockResolvedValue(undefined);
  listJsonMock.mockResolvedValue([]);
});

/** Préfixe du mois courant au format aaaa-mm (identique à celui du module). */
function monthPrefixNow(): string {
  return new Date().toISOString().slice(0, 7);
}

describe("recordTrainingAudit", () => {
  it("écrit une entrée sous le préfixe mensuel, avec détails sanitisés", async () => {
    await recordTrainingAudit({
      uid: "user-1",
      action: "dataset.imported",
      entityType: "dataset",
      entityId: "asset-42",
      projectId: "proj-7",
      ip: "203.0.113.9",
      details: { provider: "kaggle", ref: "owner/jeu", importedFiles: 3 },
    });

    expect(writeJsonMock).toHaveBeenCalledTimes(1);
    const [key, entry, options] = writeJsonMock.mock.calls[0] as [string, TrainingAuditEntry, { maxBytes: number }];
    expect(key).toMatch(/^users\/user-1\/training-audit\/\d{4}-\d{2}\/ULID.+\.json$/);
    expect(entry.action).toBe("dataset.imported");
    expect(entry.entityId).toBe("asset-42");
    expect(entry.projectId).toBe("proj-7");
    // CONFIDENTIALITÉ ABSOLUE : l'IP brute n'est JAMAIS persistée —
    // uniquement une empreinte salée tournante (16 hex).
    expect(entry.ip).toBeUndefined();
    expect(entry.ipEmpreinte).toMatch(/^[0-9a-f]{16}$/);
    expect(entry.ipEmpreinte).not.toContain("203.0.113.9");
    // JOURNAL CHAÎNÉ : l'entrée porte son scellement (ancre 32 hex
    // déterministe, empreinte de chaîne 64 hex).
    expect(entry.hashPrev).toMatch(/^[0-9a-f]{32,64}$/);
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.details).toEqual({ provider: "kaggle", ref: "owner/jeu", importedFiles: 3 });
    expect(options.maxBytes).toBeLessThanOrEqual(8192);
  });

  it("chaîne les entrées successives : chaque entrée scelle la précédente", async () => {
    await recordTrainingAudit({ uid: "user-2", action: "project.created", entityType: "project", entityId: "p1" });
    await recordTrainingAudit({ uid: "user-2", action: "arene.session", entityType: "arene", entityId: "s1" });
    const [premiere, seconde] = writeJsonMock.mock.calls.map((c) => c[1] as TrainingAuditEntry);
    expect(seconde.hashPrev).toBe(premiere.hash);
  });

  it("tronque les valeurs longues dans les détails (aucune donnée de contenu)", async () => {
    await recordTrainingAudit({
      uid: "user-1",
      action: "dataset.uploaded",
      entityType: "dataset",
      entityId: "x",
      details: { blob: "y".repeat(5000) },
    });
    const entry = writeJsonMock.mock.calls[0][1] as TrainingAuditEntry;
    expect((entry.details.blob as string).length).toBeLessThanOrEqual(200);
  });
});

describe("listTrainingAudit", () => {
  it("fusionne les deux derniers mois, trie par date inverse et filtre par projet", async () => {
    const older: TrainingAuditEntry = {
      v: 1, id: "a1", at: "2026-01-20T10:00:00.000Z", userId: "user-1",
      action: "project.created", entityType: "project", entityId: "p1", projectId: "p1", details: {},
    };
    const projectA: TrainingAuditEntry = {
      v: 1, id: "a2", at: "2026-02-01T10:00:00.000Z", userId: "user-1",
      action: "dataset.imported", entityType: "dataset", entityId: "d1", projectId: "p1", details: {},
    };
    const projectB: TrainingAuditEntry = {
      v: 1, id: "a3", at: "2026-02-05T10:00:00.000Z", userId: "user-1",
      action: "dataset.uploaded", entityType: "dataset", entityId: "d2", projectId: "p2", details: {},
    };
    // Le mois courant (réel) renvoie toutes les entrées, le mois précédent
    // rien — la fusion reste déterministe quel que soit le jour d'exécution.
    listJsonMock.mockImplementation(async (prefix: string) =>
      prefix.includes(monthPrefixNow()) ? [older, projectA, projectB] : [],
    );

    const all = await listTrainingAudit("user-1", { limit: 10 });
    expect(all.map((e) => e.id)).toEqual(["a3", "a2", "a1"]);

    const filtered = await listTrainingAudit("user-1", { limit: 10, projectId: "p1" });
    expect(filtered.map((e) => e.id)).toEqual(["a2", "a1"]);
  });

  it("borne la liste à la limite demandée", async () => {
    const many: TrainingAuditEntry[] = Array.from({ length: 30 }, (_, index) => ({
      v: 1, id: `e${index}`, at: `2026-02-0${(index % 9) + 1}T10:00:00.000Z`, userId: "user-1",
      action: "project.updated", entityType: "project", entityId: "x", details: {},
    }));
    listJsonMock.mockImplementation(async () => many);
    const limited = await listTrainingAudit("user-1", { limit: 5 });
    expect(limited.length).toBeLessThanOrEqual(5);
  });
});

describe("ipFromRequest", () => {
  it("extrait le premier saut de x-forwarded-for", async () => {
    const { NextRequest } = await import("next/server");
    const request = new NextRequest("https://gen3ia.local/api", {
      headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.1" },
    });
    expect(ipFromRequest(request)).toBe("198.51.100.7");
  });

  it("retourne undefined sans en-tête", async () => {
    const { NextRequest } = await import("next/server");
    const request = new NextRequest("https://gen3ia.local/api");
    expect(ipFromRequest(request)).toBeUndefined();
  });
});
