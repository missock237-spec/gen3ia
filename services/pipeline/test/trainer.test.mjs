import { describe, it, mock, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readdirSync, rmSync } from "node:fs";

import {
  chargerBatchState,
  lireTrainerOptions,
  nouveauBatchState,
  verifierEtDeclencher,
} from "../dist/trainer.js";

/**
 * Queue & Batching — déclenchement de l'ingestion incrémentale :
 * seuil de documents OU intervalle de temps, garde du secret absent,
 * persistance du compteur, réinitialisation après succès.
 * (Test-runner natif de Node — le pipeline est hors vitest racine.)
 */

function logger() {
  // API node:test : mock.fn(), pas mock() direct.
  const noop = () => undefined;
  return { info: mock.fn(noop), warn: mock.fn(noop), error: mock.fn(noop) };
}

async function run(etat, nouveaux, options, trigger) {
  const etatSuivant = await verifierEtDeclencher(
    etat,
    nouveaux,
    trigger ? { ...options, trigger } : options,
    // Chemin LOCAL au dossier test (jamais /tmp — alerte CodeQL
    // js/insecure-temporary-file) ; nettoyé après la suite.
    STATE_PATH_TEST,
    logger(),
  );
  return etatSuivant;
}

const STATE_PATH_TEST = join(process.cwd(), "test", ".tmp-batch-state.json");

// Nettoyage FINAL : état de test + tous les tmp UUID générés par les
// écritures de verifierEtDeclencher pendant la suite.
after(() => {
  rmSync(STATE_PATH_TEST, { force: true });
  const testDir = join(process.cwd(), "test");
  for (const fichier of readdirSync(testDir)) {
    if (fichier.startsWith(".tmp-batch-state.json") && fichier.endsWith(".tmp")) {
      rmSync(join(testDir, fichier), { force: true });
    }
  }
});

describe("verifierEtDeclencher", () => {
  const base = {
    batchThreshold: 1000,
    intervalMinutes: 60,
    ingestUrl: "https://example.test/ingest",
    cronSecret: "secret-test",
  };

  it("ne déclenche rien sous le seuil si un trigger a déjà réussi récemment", async () => {
    let appels = 0;
    const etat = { pendingSinceTrigger: 5, lastTriggerOkAt: Date.now() };
    const suivant = await run(etat, 0, base, async () => {
      appels += 1;
      return true;
    });
    assert.equal(appels, 0);
    assert.equal(suivant.pendingSinceTrigger, 5);
  });

  it("never-triggered (lastTriggerOkAt=0) + documents en attente = catch-up immédiat", async () => {
    // Sémantique : lastTriggerOkAt=0 = JAMAIS ingéré — dès que des
    // documents s'accumulent (même 5), on rattrape sans attendre l'heure
    // (reprise après install/crash : aucun document ne dort indéfiniment).
    let appels = 0;
    const etat = { pendingSinceTrigger: 0, lastTriggerOkAt: 0 };
    const suivant = await run(etat, 5, base, async () => {
      appels += 1;
      return true;
    });
    assert.equal(appels, 1);
    assert.equal(suivant.pendingSinceTrigger, 0);
  });

  it("aucun document en attente : aucun déclencheur même à l'échéance", async () => {
    let appels = 0;
    const etat = { pendingSinceTrigger: 0, lastTriggerOkAt: 0 };
    const suivant = await run(etat, 0, base, async () => {
      appels += 1;
      return true;
    });
    assert.equal(appels, 0);
    assert.equal(suivant.pendingSinceTrigger, 0);
  });

  it("déclenche au seuil (1 000 documents) et remet le compteur à zéro", async () => {
    let appels = 0;
    const etat = { pendingSinceTrigger: 999, lastTriggerOkAt: Date.now() };
    const suivant = await run(etat, 1, base, async () => {
      appels += 1;
      return true;
    });
    assert.equal(appels, 1);
    assert.equal(suivant.pendingSinceTrigger, 0);
    assert.ok(suivant.lastTriggerOkAt > 0);
  });

  it("déclenche à l'échéance de l'intervalle même avec peu de documents", async () => {
    let appels = 0;
    const etat = { pendingSinceTrigger: 3, lastTriggerOkAt: Date.now() - 61 * 60_000 };
    const suivant = await run(etat, 0, base, async () => {
      appels += 1;
      return true;
    });
    assert.equal(appels, 1);
    assert.equal(suivant.pendingSinceTrigger, 0);
  });

  it("échec du déclencheur : le compteur est CONSERVÉ (aucune perte)", async () => {
    const etat = { pendingSinceTrigger: 1000, lastTriggerOkAt: 0 };
    const suivant = await run(etat, 0, base, async () => false);
    assert.equal(suivant.pendingSinceTrigger, 1000);
    assert.equal(suivant.lastTriggerOkAt, 0);
  });

  it("secret absent : aucun appel réseau, compteur conservé", async () => {
    let appels = 0;
    const etat = { pendingSinceTrigger: 5000, lastTriggerOkAt: 0 };
    const suivant = await run(
      etat,
      0,
      { ...base, cronSecret: "" },
      async () => {
        appels += 1;
        return true;
      },
    );
    assert.equal(appels, 0);
    assert.equal(suivant.pendingSinceTrigger, 5000);
  });
});

describe("chargerBatchState", () => {
  it("état neuf si null/corrompu, valeurs invalides bornées", () => {
    assert.deepEqual(chargerBatchState(null), nouveauBatchState());
    assert.deepEqual(chargerBatchState("{pas json"), nouveauBatchState());
    assert.equal(chargerBatchState('{"pendingSinceTrigger": -5}').pendingSinceTrigger, 0);
    assert.equal(chargerBatchState('{"pendingSinceTrigger": 7.9}').pendingSinceTrigger, 7);
  });
});

describe("lireTrainerOptions", () => {
  it("défauts du guide (1 000 docs / 60 min) et surcharge env", () => {
    const defauts = lireTrainerOptions({});
    assert.equal(defauts.batchThreshold, 1000);
    assert.equal(defauts.intervalMinutes, 60);
    const custom = lireTrainerOptions({
      PIPELINE_BATCH_THRESHOLD: "250",
      PIPELINE_TRAIN_INTERVAL_MINUTES: "30",
      GEN3IA_INGEST_URL: "https://test.local/ingest",
      GEN3IA_CRON_SECRET: "s",
    });
    assert.equal(custom.batchThreshold, 250);
    assert.equal(custom.intervalMinutes, 30);
    assert.equal(custom.ingestUrl, "https://test.local/ingest");
  });
});
