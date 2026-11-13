import { describe, expect, it, vi } from "vitest";

import { FieldValue } from "@/lib/r2fs/field-value";

import { cleDateJour, compterExecutionGenAPI } from "@/lib/genapi/compteur";

/**
 * Tests du compteur genAPI : clé de date UTC (PURE) + écritures
 * FieldValue.increment sur genapiStats/{dateIso} (couche résiliente mockée).
 */

const writeCheckpointSet = vi.fn(async () => undefined);

vi.mock("@/lib/db/firestore-resilient", () => ({
  writeCheckpointSet: (...args: unknown[]) => writeCheckpointSet(...(args as [])),
}));

describe("cleDateJour — clé ISO UTC du jour (PURE)", () => {
  it("date moyenne → YYYY-MM-DD UTC", () => {
    expect(cleDateJour(new Date("2025-01-05T12:34:56Z"))).toBe("2025-01-05");
  });

  it("frontière UTC : 00:30 UTC → jour UTC (jamais la veille locale)", () => {
    expect(cleDateJour(new Date("2025-01-01T00:30:00Z"))).toBe("2025-01-01");
  });

  it("frontière UTC : 23:59 UTC → même jour", () => {
    expect(cleDateJour(new Date("2025-12-31T23:59:00Z"))).toBe("2025-12-31");
  });

  it("sans argument → date courante au format YYYY-MM-DD", () => {
    expect(cleDateJour()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("compterExecutionGenAPI — incréments best-effort sur genapiStats", () => {
  it("succès : executions +1, echecs +0, crédits débités incrémentés, document daté", async () => {
    writeCheckpointSet.mockClear();
    await compterExecutionGenAPI({ succes: true, creditsMinor: 15 });

    expect(writeCheckpointSet).toHaveBeenCalledTimes(1);
    const [collection, id, payload] = writeCheckpointSet.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(collection).toBe("genapiStats");
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload.date).toBe(id);
    expect(payload.executions).toBeInstanceOf(FieldValue);
    expect((payload.executions as FieldValue).operand).toBe(1);
    expect((payload.echecs as FieldValue).operand).toBe(0);
    expect((payload.creditsDebitesMinor as FieldValue).operand).toBe(15);
  });

  it("échec : echecs +1, crédits 0 (les compteurs suivent, ne gouvernent pas)", async () => {
    writeCheckpointSet.mockClear();
    await compterExecutionGenAPI({ succes: false, creditsMinor: 0 });

    const [, , payload] = writeCheckpointSet.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect((payload.echecs as FieldValue).operand).toBe(1);
    expect((payload.creditsDebitesMinor as FieldValue).operand).toBe(0);
  });

  it("couche Firestore en panne → SILENCIEUX (best-effort, jamais d'exception)", async () => {
    writeCheckpointSet.mockClear();
    writeCheckpointSet.mockRejectedValueOnce(new Error("Firestore sous quota."));
    await expect(compterExecutionGenAPI({ succes: true, creditsMinor: 15 })).resolves.toBeUndefined();
  });
});
