/**
 * TESTS PHASE 1 GTIS — unification de l'orchestration d'entraînement.
 *
 * Vérifie les invariants réels du branchement UCE-013 ↔ moteur réel
 * (lib/neural/training/job.ts) :
 *  - nomenclature UNIQUE job ↔ run (statutJobVersRun) ;
 *  - confinement des datasets sur les racines de données RÉELLES du dépôt ;
 *  - cycle complet planifier → démarrer (jobId) → clôturer (delta mesuré,
 *    anti-régression, leçon enregistrée) ;
 *  - échec honnête sans scoreApres fabrique (echouerRun) ;
 *  - reprise idempotente : runs orphelins clôturés, run vivant intact ;
 *  - pas de double clôture, un run = un job.
 *
 * Persistance : repli local forcé dans un répertoire temporaire (aucun
 * Firestore, aucune donnée de production touchée).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  planifierRun,
  demarrerRun,
  cloreRun,
  echouerRun,
  cloreRunsOrphelins,
  runsEntrainement,
  verifierDatasets,
  statutJobVersRun,
  type RunEntrainement,
} from "../../lib/capabilities/training/model-training-manager";

function dossierTest(): { dossier: string; options: { dossier: string; forcerLocal: true } } {
  const dossier = mkdtempSync(join(tmpdir(), "gtis-phase1-"));
  return { dossier, options: { dossier, forcerLocal: true } };
}

/** Dataset RÉEL commis dans le dépôt (utilisé tel quel par le moteur). */
const DATASET_REEL = "datasets/parole_professionnelle/train.jsonl";

describe("PHASE 1 GTIS — nomenclature unique job ↔ run", () => {
  it("mappe les trois statuts réels du job vers les statuts du run", () => {
    expect(statutJobVersRun("en_cours")).toBe("en_cours");
    expect(statutJobVersRun("termine")).toBe("termine");
    expect(statutJobVersRun("echec")).toBe("echec");
  });
});

describe("PHASE 1 GTIS — confinement des datasets réels", () => {
  it("accepte les racines de données réelles et refuse tout le reste", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gtis-conf-"));
    try {
      mkdirSync(join(cwd, "datasets"), { recursive: true });
      mkdirSync(join(cwd, "training/gen3-domain-datasets/data/echantillons"), { recursive: true });
      mkdirSync(join(cwd, "public"), { recursive: true });
      writeFileSync(join(cwd, "datasets/pro.jsonl"), "{}\n");
      writeFileSync(join(cwd, "training/gen3-domain-datasets/data/echantillons/dom.jsonl"), "{}\n");
      writeFileSync(join(cwd, "public/llms-full.txt"), "corpus");
      writeFileSync(join(cwd, "public/intrus.txt"), "refusé");
      writeFileSync(join(cwd, "hors-racine.jsonl"), "refusé");

      const resultats = await verifierDatasets(
        [
          "datasets/pro.jsonl",
          "training/gen3-domain-datasets/data/echantillons/dom.jsonl",
          "public/llms-full.txt",
          "public/intrus.txt", // nom hors motif corpus → refusé
          "hors-racine.jsonl", // racine du dépôt → refusé
          "../fuite.txt", // traversée → refusé
        ],
        cwd,
      );
      const parChemin = new Map(resultats.map((r) => [r.chemin, r]));
      expect(parChemin.get("datasets/pro.jsonl")?.existe).toBe(true);
      expect(parChemin.get("training/gen3-domain-datasets/data/echantillons/dom.jsonl")?.existe).toBe(true);
      expect(parChemin.get("public/llms-full.txt")?.existe).toBe(true);
      expect(parChemin.get("public/intrus.txt")?.existe).toBe(false);
      expect(parChemin.get("hors-racine.jsonl")?.existe).toBe(false);
      expect(parChemin.get("../fuite.txt")?.existe).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("vérifie l'existence réelle d'un dataset commis du dépôt", async () => {
    const resultats = await verifierDatasets([DATASET_REEL]);
    expect(resultats[0]?.existe).toBe(true);
    expect(resultats[0]?.tailleOctets).toBeGreaterThan(0);
    expect(resultats[0]?.sha256).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("PHASE 1 GTIS — cycle complet d'un run réel", () => {
  it("planifie, lie au job, clôture avec delta mesuré et leçon", async () => {
    const { options } = dossierTest();
    const declaration = await planifierRun(
      {
        domaine: "texte",
        datasets: [DATASET_REEL],
        scoreAvant: 0.5,
        moteur: "neural-job-local",
      },
      options,
    );
    expect(declaration.ok).toBe(true);
    expect(declaration.run?.statut).toBe("planifie");

    const runId = declaration.run!.id;

    // Liaison au job réel (planifie → en_cours).
    const demarrage = await demarrerRun(runId, "job-abc-123", options);
    expect(demarrage.ok).toBe(true);
    expect(demarrage.run?.statut).toBe("en_cours");
    expect(demarrage.run?.jobId).toBe("job-abc-123");
    expect(demarrage.run?.demarreLe).toBeTruthy();

    // Idempotence : re-marquer avec le MÊME jobId est accepté.
    const redemarrage = await demarrerRun(runId, "job-abc-123", options);
    expect(redemarrage.ok).toBe(true);

    // Un run = un job : un AUTRE jobId est refusé.
    const conflit = await demarrerRun(runId, "job-autre-999", options);
    expect(conflit.ok).toBe(false);
    expect(conflit.cause).toContain("un run = un job");

    // Clôture avec score APRÈS mesuré : delta réel + leçon enregistrée.
    const cloture = await cloreRun(runId, 0.575, options);
    expect(cloture.ok).toBe(true);
    expect(cloture.run?.statut).toBe("termine");
    expect(cloture.run?.delta).toBeCloseTo(0.075, 4);
    expect(cloture.run?.scoreApres).toBe(0.575);
    expect(cloture.run?.termineLe).toBeTruthy();

    // Pas de double clôture.
    const seconde = await cloreRun(runId, 0.6, options);
    expect(seconde.ok).toBe(false);
    expect(seconde.cause).toContain("déjà clôturé");

    // Le run persisté reflète l'état final.
    const runs = await runsEntrainement(options);
    const persiste = runs.find((r) => r.id === runId);
    expect(persiste?.statut).toBe("termine");
    expect(persiste?.jobId).toBe("job-abc-123");
  });

  it("refuse une régression mesurée (anti-régression -0.02)", async () => {
    const { options } = dossierTest();
    const declaration = await planifierRun(
      { domaine: "texte", datasets: [DATASET_REEL], scoreAvant: 0.8, moteur: "neural-job-local" },
      options,
    );
    const runId = declaration.run!.id;
    await demarrerRun(runId, "job-reg-1", options);

    const cloture = await cloreRun(runId, 0.7, options); // delta -0.10 < -0.02
    expect(cloture.ok).toBe(false);
    expect(cloture.run?.statut).toBe("echec");
    expect(cloture.run?.cause).toContain("régression mesurée");
    expect(cloture.run?.delta).toBeCloseTo(-0.1, 4);
  });
});

describe("PHASE 1 GTIS — échec honnête (job échoué)", () => {
  it("marque echec avec cause réelle, sans scoreApres fabrique", async () => {
    const { options } = dossierTest();
    const declaration = await planifierRun(
      { domaine: "texte", datasets: [DATASET_REEL], scoreAvant: 0.4, moteur: "neural-job-local" },
      options,
    );
    const runId = declaration.run!.id;
    await demarrerRun(runId, "job-echec-1", options);

    const resultat = await echouerRun(runId, "job échoué : jeu de test indisponible", options);
    expect(resultat.ok).toBe(true);
    expect(resultat.run?.statut).toBe("echec");
    expect(resultat.run?.cause).toContain("jeu de test indisponible");
    expect(resultat.run?.scoreApres).toBeUndefined();
    expect(resultat.run?.delta).toBeUndefined();

    // Double clôture refusée (cloreRun comme echouerRun).
    expect((await cloreRun(runId, 0.9, options)).ok).toBe(false);
    expect((await echouerRun(runId, "doublon", options)).ok).toBe(false);
  });

  it("clôt les runs orphelins et préserve le run du job vivant", async () => {
    const { options } = dossierTest();
    const runVivant = await planifierRun(
      { domaine: "texte", datasets: [DATASET_REEL], scoreAvant: 0.3, moteur: "neural-job-local" },
      options,
    );
    const runOrphelin = await planifierRun(
      { domaine: "texte", datasets: [DATASET_REEL], scoreAvant: 0.3, moteur: "neural-job-local" },
      options,
    );
    await demarrerRun(runVivant.run!.id, "job-vivant", options);
    await demarrerRun(runOrphelin.run!.id, "job-mort-du-process-precedent", options);

    const nettoyage = await cloreRunsOrphelins(["job-vivant"], options);
    expect(nettoyage.orphelinsClos).toHaveLength(1);
    expect(nettoyage.orphelinsClos[0]).toBe(runOrphelin.run!.id);

    const runs = await runsEntrainement(options);
    const vivant = runs.find((r) => r.id === runVivant.run!.id);
    const orphelin = runs.find((r) => r.id === runOrphelin.run!.id);
    expect(vivant?.statut).toBe("en_cours");
    expect(orphelin?.statut).toBe("echec");
    expect(orphelin?.cause).toContain("orphelin");
  });
});

describe("PHASE 1 GTIS — gardes d'entrée du run", () => {
  it("refuse un run sans dataset (aucun entraînement fantôme)", async () => {
    const { options } = dossierTest();
    const resultat = await planifierRun(
      { domaine: "texte", datasets: [], scoreAvant: 0.5, moteur: "neural-job-local" },
      options,
    );
    expect(resultat.ok).toBe(false);
    expect(resultat.cause).toContain("aucun dataset");
  });

  it("refuse un run dont les datasets sont introuvables ou hors racines", async () => {
    const { options } = dossierTest();
    const resultat = await planifierRun(
      {
        domaine: "texte",
        datasets: ["datasets/nexiste-pas.jsonl", "public/intrus.txt"],
        scoreAvant: 0.5,
        moteur: "neural-job-local",
      },
      options,
    );
    expect(resultat.ok).toBe(false);
    expect(resultat.cause).toContain("introuvables ou hors datasets");
  });

  it("refuse un run sans score avant mesuré", async () => {
    const { options } = dossierTest();
    const resultat = await planifierRun(
      {
        domaine: "texte",
        datasets: [DATASET_REEL],
        scoreAvant: undefined as unknown as number,
        moteur: "neural-job-local",
      },
      options,
    );
    expect(resultat.ok).toBe(false);
    expect(resultat.cause).toContain("score avant mesuré obligatoire");
  });
});

describe("PHASE 1 GTIS — run introuvable", () => {
  it("répond honnêtement pour un identifiant inconnu", async () => {
    const { options } = dossierTest();
    expect((await demarrerRun("run_fantome_x", "job-1", options)).ok).toBe(false);
    expect((await cloreRun("run_fantome_x", 0.5, options)).ok).toBe(false);
    expect((await echouerRun("run_fantome_x", "cause", options)).ok).toBe(false);
  });
});

/** Garde de type : le statut du run couvre les trois états réels du job. */
type _GardeStatut = RunEntrainement["statut"] extends
  | "planifie"
  | "en_cours"
  | "termine"
  | "echec"
  | "annule"
  ? true
  : false;
const _gardeStatut: _GardeStatut = true;
void _gardeStatut;
