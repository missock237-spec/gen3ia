import { describe, expect, it, vi } from "vitest";

/**
 * Task 120 — tests du pool de concurrence BORNÉE maison (concurrency.ts) :
 * ordre stable des résultats, isolation des erreurs, concurrence stricte,
 * shouldStart (budget temps) sans casser l'ordre.
 */

import { anyRejected, firstRejectedReason, mapWithConcurrency } from "./concurrency";

/** Compteur de workers simultanés (max observé) pour vérifier la borne. */
function trackedWorker(track: { active: number; max: number }, delayMs: number) {
  return async (value: number): Promise<number> => {
    track.active += 1;
    track.max = Math.max(track.max, track.active);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    track.active -= 1;
    return value * 2;
  };
}

describe("mapWithConcurrency", () => {
  it("résultats dans l'ORDRE des entrées (même avec des durées inversées)", async () => {
    const outcomes = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      // Le premier est le plus LENT : l'ordre naturel d'achèvement est inversé.
      await new Promise((resolve) => setTimeout(resolve, (5 - n) * 15));
      return n * 10;
    });
    expect(outcomes).toEqual([
      { status: "fulfilled", value: 10 },
      { status: "fulfilled", value: 20 },
      { status: "fulfilled", value: 30 },
      { status: "fulfilled", value: 40 },
    ]);
  });

  it("erreurs ISOLÉES : un item qui jette n'interrompt pas les autres", async () => {
    const outcomes = await mapWithConcurrency([1, 2, 3], 3, async (n) => {
      if (n === 2) throw new Error(`échec ${n}`);
      return n;
    });
    expect(outcomes[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(outcomes[1].status).toBe("rejected");
    expect(outcomes[2]).toEqual({ status: "fulfilled", value: 3 });
    expect(anyRejected(outcomes)).toBe(true);
    expect(firstRejectedReason(outcomes)).toBeInstanceOf(Error);
    expect((firstRejectedReason(outcomes) as Error).message).toBe("échec 2");
  });

  it("concurrence STRICTE : jamais plus de `limit` workers simultanés", async () => {
    const track = { active: 0, max: 0 };
    const outcomes = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, trackedWorker(track, 20));
    expect(outcomes.every((o) => o.status === "fulfilled")).toBe(true);
    expect(track.max).toBeLessThanOrEqual(2);
    expect(track.max).toBeGreaterThanOrEqual(2); // le pool travaille VRAIMENT en parallèle
  });

  it("limit 0/invalide → repli 1 worker (jamais de division par zéro)", async () => {
    const track = { active: 0, max: 0 };
    const outcomes = await mapWithConcurrency([1, 2, 3], 0, trackedWorker(track, 5));
    expect(outcomes.every((o) => o.status === "fulfilled")).toBe(true);
    expect(track.max).toBe(1);
  });

  it("shouldStart false → « skipped » SANS appeler le worker ni consommer de slot", async () => {
    const worker = vi.fn(async (n: number) => n);
    const outcomes = await mapWithConcurrency([1, 2, 3], 2, worker, {
      // seul le premier item est autorisé à démarrer (budget temps épuisé ensuite)
      shouldStart: (index) => index === 0,
    });
    expect(outcomes).toEqual([{ status: "fulfilled", value: 1 }, { status: "skipped" }, { status: "skipped" }]);
    expect(worker).toHaveBeenCalledTimes(1);
  });

  it("première raison de rejet dans l'ORDRE (déterminisme)", async () => {
    const outcomes = await mapWithConcurrency(["a", "b", "c"], 3, async (s) => {
      if (s === "a") throw new Error("première");
      if (s === "c") throw new Error("deuxième");
      return s;
    });
    expect((firstRejectedReason(outcomes) as Error).message).toBe("première");
  });

  it("anyRejected false quand tout est rempli ou sauté", async () => {
    const outcomes = await mapWithConcurrency([1], 1, async () => 42, { shouldStart: () => true });
    expect(anyRejected(outcomes)).toBe(false);
  });
});
