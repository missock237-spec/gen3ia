/**
 * DÉMO PP — exécution réelle archivée (wrapper vitest : le dépôt stubbe
 * `server-only` uniquement via vitest ; le même module tourne en production
 * depuis instrumentation.ts sans stub).
 */

import { describe, expect, it } from "vitest";

import { runProductionDemo } from "@/scripts/pp/demo-production";

describe("démo PP — cycle de production réel", () => {
  it("8 étapes opérationnelles mesurées + rapport JSON archivé", async () => {
    const report = await runProductionDemo("/home/z/my-project/download/pp-demo-production-2026-11-27.json");
    expect(report.etapes).toHaveLength(9);
    expect(report.conclusion.operationnel).toBe(true);
    expect(report.conclusion.blocages).toEqual([]);
  }, 180_000);
});
