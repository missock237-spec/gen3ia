import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Task 106-fix / Task 108 — GARDE STRUCTUREL : cohérence de RÉGIME
 * claim↔checkpoints.
 *
 * Constat production (Task 106) : le disjoncteur quota Firestore ouvert
 * déviait les écritures résilientes (checkpoints de segments/scènes) vers le
 * second backend, tandis que le claim transactionnel réussissait encore sur
 * Firestore — il relisait l'ancien document (checkpoints absents) et
 * re-rendait les mêmes segments à l'infini. Depuis Task 108 (second backend
 * supprimé), l'invariant est INVERSE mais tout aussi critique : quand
 * `firestoreUsable()` renvoie false, le claim doit RENONCER (erreur
 * quota-classifiée propagée) — aucun chemin ne progresse tant que le quota
 * ne revient pas, la reprise se fait après cooldown (backoff des files).
 */

const renderSource = readFileSync(path.join(import.meta.dirname, "render-queue.ts"), "utf8");
const productionSource = readFileSync(path.join(import.meta.dirname, "production-queue.ts"), "utf8");
const resilientSource = readFileSync(path.join(import.meta.dirname, "../db/firestore-resilient.ts"), "utf8");

describe("cohérence de régime claim ↔ checkpoints (Task 106-fix / 108)", () => {
  it("le disjoncteur est exporté (firestoreUsable) pour les files", () => {
    expect(resilientSource).toContain("export function firestoreUsable()");
  });

  it("claim rendu : renonce quand le disjoncteur est ouvert (erreur quota-classifiée)", () => {
    const claimStart = renderSource.indexOf("async function claimJobForTick");
    expect(claimStart).toBeGreaterThan(0);
    const claimBody = renderSource.slice(claimStart, claimStart + 2200);
    expect(claimBody).toContain("if (!firestoreUsable())");
    expect(claimBody).toContain("throw new Error");
    // Plus AUCUN chemin miroir secondaire
    expect(claimBody).not.toContain("claimJobViaMirror");
  });

  it("claim production : même renonciation (même régime que les checkpoints)", () => {
    const claimStart = productionSource.indexOf("async function claimProductionJob");
    expect(claimStart).toBeGreaterThan(0);
    const claimBody = productionSource.slice(claimStart, claimStart + 2200);
    expect(claimBody).toContain("if (!firestoreUsable())");
    expect(claimBody).toContain("throw new Error");
    expect(claimBody).not.toContain("claimProductionViaMirror");
  });

  it("route GET render : maxDuration relevé à 120 s (kill sans checkpoint impossible)", () => {
    const route = readFileSync(
      path.join(import.meta.dirname, "../../app/api/video/projects/[projectId]/render/route.ts"),
      "utf8",
    );
    expect(route).toContain("export const maxDuration = 120;");
  });
});
