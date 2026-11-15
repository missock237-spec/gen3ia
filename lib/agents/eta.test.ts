import { describe, expect, it } from "vitest";

import { estimateRunEta, formatRunEta, isRunActive } from "./eta";
import type { RunStep } from "@/lib/domain/conversations/types";

/**
 * Étape 9 du plan 20 — estimation du temps de livraison affichée pendant
 * l'exécution. Contrats verrouillés :
 *  1. les durées RÉELLES mesurées sur les étapes terminées priment ;
 *  2. les durées typiques par phase servent de repli (basis "typical") ;
 *  3. l'étape en cours est créditée du temps déjà écoulé ;
 *  4. les validations humaines (awaiting) sont EXCLUES et annoncées à part ;
 *  5. formatage honnête (moins d'une minute / ~N min (HH:MM) / >30 min) ;
 *  6. chaîne vide quand tout est terminé.
 */

const NOW = Date.parse("2026-10-01T10:00:00.000Z");

function step(overrides: Partial<RunStep>): RunStep {
  return {
    id: "s1",
    phase: "execution",
    title: "Étape",
    status: "pending",
    ...overrides,
  };
}

describe("estimateRunEta", () => {
  it("retourne une estimation nulle quand tout est terminé", () => {
    const eta = estimateRunEta([
      step({ status: "done", startedAt: "2026-10-01T09:58:00.000Z", finishedAt: "2026-10-01T09:59:00.000Z" }),
    ], NOW);
    expect(eta.remainingMs).toBe(0);
    expect(eta.basis).toBe("none");
    expect(eta.completedCount).toBe(eta.totalSteps);
  });

  it("utilise la durée mesurée réelle des étapes terminées (basis measured)", () => {
    const eta = estimateRunEta([
      step({ status: "done", phase: "execution", startedAt: "2026-10-01T09:58:00.000Z", finishedAt: "2026-10-01T09:59:00.000Z" }),
      step({ status: "pending", phase: "execution" }),
    ], NOW);
    expect(eta.basis).toBe("measured");
    // La médiane mesurée pour la phase execution = 60 000 ms.
    expect(eta.remainingMs).toBe(60_000);
  });

  it("replie sur les durées typiques quand rien n'est mesuré", () => {
    const eta = estimateRunEta([
      step({ status: "pending", phase: "understanding" }),
      step({ status: "pending", phase: "plan" }),
    ], NOW);
    expect(eta.basis).toBe("typical");
    expect(eta.remainingMs).toBe(8_000 + 12_000);
  });

  it("crédite l'étape en cours du temps déjà écoulé (plancher 1 s)", () => {
    const eta = estimateRunEta([
      step({ status: "in_progress", phase: "execution", startedAt: "2026-10-01T09:59:40.000Z" }),
    ], NOW);
    // Coût typique 30 000 ms, 20 000 ms écoulés → reste ≥ 1 000 ms et ≈ 10 000 ms.
    expect(eta.remainingMs).toBeGreaterThanOrEqual(1_000);
    expect(eta.remainingMs).toBeLessThanOrEqual(11_000);
  });

  it("EXCLUT les validations humaines de l'estimation mais les compte à part", () => {
    const eta = estimateRunEta([
      step({ status: "awaiting", phase: "approval" }),
      step({ status: "pending", phase: "execution" }),
    ], NOW);
    expect(eta.awaitingCount).toBe(1);
    expect(eta.remainingMs).toBe(30_000); // seulement l'étape execution
  });

  it("ignore les étapes annulées/sautées dans le total", () => {
    const eta = estimateRunEta([
      step({ status: "skipped" }),
      step({ status: "pending", phase: "result" }),
    ], NOW);
    expect(eta.totalSteps).toBe(1);
    expect(eta.remainingMs).toBe(6_000);
  });
});

describe("formatRunEta", () => {
  it("annonce « moins d'une minute » en dessous de 60 s", () => {
    const text = formatRunEta({
      remainingMs: 20_000,
      estimatedDeliveryAt: NOW + 20_000,
      basis: "typical",
      completedCount: 2,
      totalSteps: 3,
      awaitingCount: 0,
    }, NOW);
    expect(text).toMatch(/moins d'une minute/);
  });

  it("annonce ~N min avec l'heure de livraison estimée", () => {
    const text = formatRunEta({
      remainingMs: 120_000,
      estimatedDeliveryAt: NOW + 120_000,
      basis: "measured",
      completedCount: 1,
      totalSteps: 3,
      awaitingCount: 0,
    }, NOW);
    expect(text).toMatch(/~2 min \(10:02\)/);
  });

  it("mentionne explicitement les validations humaines en attente", () => {
    const text = formatRunEta({
      remainingMs: 60_000,
      estimatedDeliveryAt: NOW + 60_000,
      basis: "typical",
      completedCount: 0,
      totalSteps: 3,
      awaitingCount: 2,
    }, NOW);
    expect(text).toMatch(/hors 2 validations en attente de votre accord/);
  });

  it("retourne une chaîne vide quand il n'y a plus rien à estimer", () => {
    expect(formatRunEta({
      remainingMs: 0,
      estimatedDeliveryAt: NOW,
      basis: "none",
      completedCount: 3,
      totalSteps: 3,
      awaitingCount: 0,
    }, NOW)).toBe("");
  });
});

describe("isRunActive", () => {
  it("running et paused sont actifs, pas les autres statuts", () => {
    expect(isRunActive("running")).toBe(true);
    expect(isRunActive("paused")).toBe(true);
    expect(isRunActive("completed")).toBe(false);
    expect(isRunActive("failed")).toBe(false);
  });
});
