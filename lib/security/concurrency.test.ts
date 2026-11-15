import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Garde de concurrence (durcissement production) — sémaphore process-local
 * des tours IA : admission sous plafond, refus honnête en saturation,
 * release idempotent, plafond configurable sans redéploiement, exposition
 * Prometheus.
 */

describe("lib/security/concurrency", () => {
  let mod: typeof import("./concurrency");

  beforeEach(async () => {
    vi.resetModules();
    (globalThis as unknown as Record<string, unknown>).__gen3ia_concurrence_ia__ = undefined;
    delete process.env.GEN3IA_MAX_CONCURRENT_TURNS;
    mod = await import("./concurrency");
  });

  afterEach(() => {
    delete process.env.GEN3IA_MAX_CONCURRENT_TURNS;
  });

  it("admet sous le plafond par défaut et compte les actifs", () => {
    const a = mod.acquiertourIa("test-a");
    const b = mod.acquiertourIa("test-b");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(mod.instantaneConcurrence().actifs).toBe(2);
    expect(mod.instantaneConcurrence().totalAcquis).toBe(2);

    a?.release();
    b?.release();
    expect(mod.instantaneConcurrence().actifs).toBe(0);
  });

  it("refuse (null) en saturation et trace le refus par route", () => {
    process.env.GEN3IA_MAX_CONCURRENT_TURNS = "2";
    const un = mod.acquiertourIa("chat");
    const deux = mod.acquiertourIa("chat");
    const trois = mod.acquiertourIa("media");

    expect(un).not.toBeNull();
    expect(deux).not.toBeNull();
    expect(trois).toBeNull();
    expect(mod.instantaneConcurrence().totalRefuses).toBe(1);
    expect(mod.instantaneConcurrence().refusesParRoute).toEqual([{ route: "media", total: 1 }]);
  });

  it("relit le plafond À L'APPEL (changement d'env sans redéploiement)", () => {
    process.env.GEN3IA_MAX_CONCURRENT_TURNS = "1";
    expect(mod.acquiertourIa("x")).not.toBeNull();
    expect(mod.acquiertourIa("x")).toBeNull();
    // Le plafond monte : le créneau suivant est accordé.
    process.env.GEN3IA_MAX_CONCURRENT_TURNS = "4";
    expect(mod.acquiertourIa("x")).not.toBeNull();
  });

  it("release est IDEMPOTENT (double appel sans effet de bord)", () => {
    const jeton = mod.acquiertourIa("idempotent");
    jeton?.release();
    jeton?.release();
    expect(mod.instantaneConcurrence().actifs).toBe(0);
  });

  it("expose une sortie Prometheus honnête (aucun refus → série à 0)", () => {
    const sortie = mod.concurrencePrometheus();
    expect(sortie).toContain("gen3ia_concurrency_active 0");
    expect(sortie).toContain(`gen3ia_concurrency_max ${mod.CONCURRENCE_DEFAUT}`);
    expect(sortie).toContain('gen3ia_concurrency_rejected_total{route="aucune"} 0');
  });

  it("plafond illisible ou négatif retombe sur le défaut (jamais de blocage total)", () => {
    process.env.GEN3IA_MAX_CONCURRENT_TURNS = "-5";
    // Aucun refus au premier appel : la garde protège, elle ne ferme pas.
    expect(mod.acquiertourIa("defaut")).not.toBeNull();
  });
});
