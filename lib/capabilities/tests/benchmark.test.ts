import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { benchmarker, comparerCandidates } from "../evaluation/benchmark-engine";
import { reinitialiserRepositoryUce } from "../storage/capability-repository";

/**
 * TESTS BENCHMARK (mission §11) — mesures réelles et reproductibles en
 * sandbox : N runs, stats honnêtes (p50/p95), verdict basé sur le taux de
 * succès mesuré, comparaison de plusieurs candidats.
 */

let dossier: string;

beforeEach(async () => {
  dossier = await fs.mkdtemp(path.join(os.tmpdir(), "uce-bench-"));
  reinitialiserRepositoryUce();
});

afterEach(async () => {
  reinitialiserRepositoryUce();
  await fs.rm(dossier, { recursive: true, force: true });
});

const SCRIPT_OK = `
const { emettre } = require("sandbox-uce");
const debut = Date.now();
// travail réel borné : somme de 10 000 éléments
let somme = 0;
for (let i = 0; i < 10000; i++) somme += i;
const memoire = process.memoryUsage();
emettre({ ok: true, somme, memoireMo: memoire.heapUsed / (1024 * 1024), duree: Date.now() - debut });
`;

const SCRIPT_KO = `
const { emettre } = require("sandbox-uce");
emettre({ ok: false });
`;

describe("moteur de benchmark", () => {
  it("mesure réellement un scénario réussi : runs, taux de succès, p50/p95, mémoire", async () => {
    const resultat = await benchmarker("test:bench:ok", { nom: "somme", script: SCRIPT_OK }, { runs: 3, dossier, persister: false });
    expect(resultat.benchmark.stats.runs).toBe(3);
    expect(resultat.benchmark.stats.succes).toBe(3);
    expect(resultat.benchmark.stats.tauxSucces).toBe(1);
    expect(resultat.benchmark.stats.latenceP95Ms).toBeGreaterThanOrEqual(resultat.benchmark.stats.latenceMinMs);
    expect(resultat.benchmark.stats.memoirePicMo).toBeGreaterThan(0);
    expect(resultat.verdict).toBe("fiable");
  }, 60_000);

  it("rend le verdict « echec » quand le scénario échoue (honnêteté)", async () => {
    const resultat = await benchmarker("test:bench:ko", { nom: "echec", script: SCRIPT_KO }, { runs: 2, dossier, persister: false });
    expect(resultat.benchmark.stats.tauxSucces).toBe(0);
    expect(resultat.verdict).toBe("echec");
  }, 60_000);

  it("compare plusieurs candidats et les classe sans réinventer les mesures", async () => {
    const classement = await comparerCandidates(
      [
        { capabilityId: "test:a", scenario: { nom: "a", script: SCRIPT_OK } },
        { capabilityId: "test:b", scenario: { nom: "b", script: SCRIPT_KO } },
      ],
      { runs: 2, dossier, persister: false },
    );
    expect(classement.length).toBe(2);
    const a = classement.find((c) => c.capabilityId === "test:a");
    const b = classement.find((c) => c.capabilityId === "test:b");
    expect(a?.verdict).toBe("fiable");
    expect(b?.verdict).toBe("echec");
  }, 90_000);
});
