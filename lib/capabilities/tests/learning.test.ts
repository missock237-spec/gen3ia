import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { validerAmelioration } from "../learning/learning-validator";
import { enregistrerLearning } from "../builder/skill-generator";
import { leconsValidees } from "../learning/capability-learning";
import { reinitialiserRepositoryUce } from "../storage/capability-repository";

/**
 * TESTS LEARNING (mission §11) — mesure avant/après sur jeu de test
 * indépendant, garde anti-régression (seuil 0.02), distinction
 * connaissance / compétence / neural.
 */

let dossier: string;

beforeEach(async () => {
  dossier = await fs.mkdtemp(path.join(os.tmpdir(), "uce-learn-"));
  reinitialiserRepositoryUce();
});

afterEach(async () => {
  reinitialiserRepositoryUce();
  await fs.rm(dossier, { recursive: true, force: true });
});

describe("validateur d'apprentissage", () => {
  it("accepte une amélioration mesurée et conserve la leçon", async () => {
    const res = await validerAmelioration(
      async () => 0.5,
      async () => 0.7,
      { jeuTest: "jeu-test-independant-a", lecon: "amélioration de la précision du solveur", dossier },
    );
    expect(res.acceptee).toBe(true);
    expect(res.delta).toBeCloseTo(0.2);
    const lecons = await leconsValidees({ dossier, forcerLocal: true });
    expect(lecons.length).toBeGreaterThanOrEqual(1);
  });

  it("REFUSE une régression > seuil 0.02 et trace le refus", async () => {
    const res = await validerAmelioration(
      async () => 0.8,
      async () => 0.7,
      { jeuTest: "jeu-test-independant-b", dossier },
    );
    expect(res.acceptee).toBe(false);
    expect(res.delta).toBeLessThan(-0.02);
    const { lister } = await import("../storage/capability-repository");
    const tous = await lister<import("../core/capability-contract").CapabilityLearning>("learning", undefined, 100, { dossier, forcerLocal: true });
    const trace = tous.find((l) => l.regressionDetectee);
    expect(trace).toBeDefined();
    expect(trace?.valide).toBe(false);
  });

  it("refuse une amélioration insuffisante (bruit, pas de conservation)", async () => {
    const res = await validerAmelioration(
      async () => 0.5,
      async () => 0.52,
      { dossier },
    );
    expect(res.acceptee).toBe(false);
    expect(res.cause).toContain("insuffisante");
  });
});

describe("acquisition de connaissances", () => {
  it("refuse fail-closed une leçon contenant un secret", async () => {
    const record = await enregistrerLearning({
      kind: "connaissance",
      lecon: "mon token hf_FAKEAAAABBBBCCCCDDDDEEEEFFFFGGGG doit être masqué",
      valide: true,
      regressionDetectee: false,
      dossier,
    });
    expect(record.lecon).not.toContain("hf_FAKEAAAABBBBCCCCDDDDEEEEFFFFGGGG");
  });
});
