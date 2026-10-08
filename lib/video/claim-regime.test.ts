import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Task 106-fix — GARDE STRUCTUREL : cohérence de RÉGIME claim↔checkpoints.
 *
 * Constat production (Task 106) : le disjoncteur quota Firestore ouvert
 * dévie les écritures résilientes (checkpoints de segments/scènes) vers le
 * miroir Supabase, tandis que le claim transactionnel réussissait encore
 * sur Firestore — il relisait l'ancien document (checkpoints absents) et
 * re-rendait les mêmes segments à l'infini. Le claim DOIT basculer vers le
 * miroir dès que `firestoreUsable()` renvoie false (les deux files).
 */

const renderSource = readFileSync(path.join(import.meta.dirname, "render-queue.ts"), "utf8");
const productionSource = readFileSync(path.join(import.meta.dirname, "production-queue.ts"), "utf8");
const fallbackSource = readFileSync(path.join(import.meta.dirname, "../db/firestore-fallback.ts"), "utf8");

describe("cohérence de régime claim ↔ checkpoints (Task 106-fix)", () => {
  it("le disjoncteur est exporté (firestoreUsable) pour les files", () => {
    expect(fallbackSource).toContain("export function firestoreUsable()");
  });

  it("claim rendu : bascule miroir dès l'ouverture du disjoncteur", () => {
    const claimStart = renderSource.indexOf("async function claimJobForTick");
    const helperStart = renderSource.indexOf("async function claimJobViaMirror");
    expect(claimStart).toBeGreaterThan(0);
    expect(helperStart).toBeGreaterThan(claimStart);
    const claimBody = renderSource.slice(claimStart, helperStart);
    expect(claimBody).toContain("if (!firestoreUsable())");
    expect(claimBody).toContain("claimJobViaMirror");
  });

  it("claim production : même bascule (même régime que saveJobDoc)", () => {
    const claimStart = productionSource.indexOf("async function claimProductionJob");
    const helperStart = productionSource.indexOf("async function claimProductionViaMirror");
    expect(claimStart).toBeGreaterThan(0);
    expect(helperStart).toBeGreaterThan(claimStart);
    const claimBody = productionSource.slice(claimStart, helperStart);
    expect(claimBody).toContain("if (!firestoreUsable())");
    expect(claimBody).toContain("claimProductionViaMirror");
  });

  it("route GET render : maxDuration relevé à 120 s (kill sans checkpoint impossible)", () => {
    const route = readFileSync(
      path.join(import.meta.dirname, "../../app/api/video/projects/[projectId]/render/route.ts"),
      "utf8",
    );
    expect(route).toContain("export const maxDuration = 120;");
  });
});
