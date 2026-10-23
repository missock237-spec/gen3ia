import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RegistreModeles } from "./registry";
import {
  executerPipeline,
  type AdaptateurEntrainement,
  type ResultatEntrainement,
} from "./pipeline";

/**
 * PIPELINE D'ENTRAÎNEMENT À PORTE D'ÉVALUATION — 4 étapes idempotentes sur
 * le corpus RÉEL du dépôt (public/llms*.txt) avec un mécanisme d'entraînement
 * INJECTÉ (le cerveau neuronal n'est JAMAIS construit dans ces tests) :
 *  - promotion (première version, artefact empreinté sha256) ;
 *  - quarantaine (métrique dégradée vs baseline, dérive PSI) ;
 *  - idempotence (reprise : pas de re-entraînement, pointeur intact) ;
 *  - re-gate d'une quarantaine (promotion sans re-entraîner) ;
 *  - échecs durs (adaptateur en erreur, artefact introuvable, planchers).
 *
 * Chaque test travaille dans un dossier temporaire dédié (jamais var/).
 */

const temporaires: string[] = [];

function environnement(): {
  registre: RegistreModeles;
  racine: string;
  cheminArtefact: string;
} {
  const racine = mkdtempSync(join(tmpdir(), "gen3-pipeline-"));
  const artefacts = mkdtempSync(join(tmpdir(), "gen3-pipeline-art-"));
  temporaires.push(racine, artefacts);
  const cheminArtefact = join(artefacts, "cortex-v2.bin");
  writeFileSync(cheminArtefact, Buffer.from([1, 2, 3, 4, 5, 250]));
  return { registre: new RegistreModeles(racine), racine, cheminArtefact };
}

/** Adaptateur injecté : renvoie un résultat FIXE (aucun entraînement réel). */
function adaptateurFactice(
  resultat: ResultatEntrainement,
  compteur: { appels: number } = { appels: 0 },
): AdaptateurEntrainement & { compteur: { appels: number } } {
  const adaptateur = async () => {
    compteur.appels += 1;
    return {
      ...resultat,
      metriques: resultat.metriques.map((m) => ({ ...m })),
      hyperparams: { ...resultat.hyperparams },
    };
  };
  return Object.assign(adaptateur, { compteur });
}

/** Adaptateur injecté en échec (simulation d'incident d'entraînement). */
function adaptateurEnEchec(erreur = "incident simulé"): AdaptateurEntrainement {
  return async () => {
    throw new Error(erreur);
  };
}

afterEach(() => {
  while (temporaires.length > 0) {
    const dir = temporaires.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("pipeline MLOps à porte d'évaluation (lib/mlops/pipeline)", () => {
  it("run complet : première version PROMUE (ingestion réelle, artefact empreinté, distribution embarquée)", async () => {
    const { registre, cheminArtefact } = environnement();
    const shaAttendu = createHash("sha256")
      .update(readFileSync(cheminArtefact))
      .digest("hex");

    const rapport = await executerPipeline({
      modelId: "gen3-cortex-v2",
      version: "1.0.0",
      registre,
      cheminArtefact,
      gitSha: "cfc052a6",
      hyperparams: { epochs: 2 },
      adaptateur: adaptateurFactice({
        metriques: [
          { nom: "accuracy_test", valeur: 0.9 },
          { nom: "accuracy_train", valeur: 0.95 },
        ],
        hyperparams: { epochs: 2, echantillonsEntraines: 100 },
        jobId: "job-1",
      }),
    });

    // (a) ingestion — stats réelles du corpus du dépôt.
    expect(rapport.etapes.ingestion.ok).toBe(true);
    expect(rapport.etapes.ingestion.echantillonsCorpus).toBeGreaterThan(0);
    expect(rapport.etapes.ingestion.echantillonsAmorcage).toBeGreaterThan(0);
    expect(rapport.etapes.ingestion.corpusSha256).toMatch(/^[0-9a-f]{64}$/);

    // (b) entraînement délégué + empreinte RÉELLE de l'artefact.
    expect(rapport.etapes.entrainement.statut).toBe("execute");
    expect(rapport.etapes.entrainement.jobId).toBe("job-1");
    expect(rapport.etapes.entrainement.artefact?.sha256).toBe(shaAttendu);
    expect(rapport.etapes.entrainement.artefact?.bytes).toBe(6);

    // (c) évaluation : pas de baseline (première version).
    expect(rapport.etapes.evaluation.baselineVersion).toBeNull();
    expect(rapport.etapes.evaluation.comparaisons.every((c) => c.statut === "ok")).toBe(true);

    // (d) porte ouverte → production.
    expect(rapport.reprise).toBe(false);
    expect(rapport.decision).toBe("promotion");
    expect(rapport.etapes.porte.canalFinal).toBe("production");
    expect(rapport.manifest?.channel).toBe("production");

    const enProd = await registre.latest("gen3-cortex-v2", "production");
    expect(enProd?.version).toBe("1.0.0");
    expect(enProd?.lineage.source).toBe("pipeline");
    expect(enProd?.lineage.parentVersion).toBeUndefined();
    expect(enProd?.datasets[0]?.reference).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Distribution de référence embarquée : somme = échantillons du run.
    const distribution = enProd?.hyperparams[
      "distributionEntrainement"
    ] as Record<string, number>;
    const total = Object.values(distribution).reduce((a, b) => a + b, 0);
    expect(total).toBe(
      rapport.etapes.ingestion.echantillonsCorpus +
        rapport.etapes.ingestion.echantillonsAmorcage,
    );
  });

  it("porte fermée : métrique dégradée vs baseline → QUARANTAINE + lignage automatique", async () => {
    const { registre, cheminArtefact } = environnement();
    const communs = { modelId: "gen3-cortex-v2", registre, cheminArtefact, gitSha: "cfc052a6" as const };

    await executerPipeline({
      ...communs,
      version: "1.0.0",
      adaptateur: adaptateurFactice({
        metriques: [{ nom: "accuracy_test", valeur: 0.9 }],
        hyperparams: {},
      }),
    });

    const rapport = await executerPipeline({
      ...communs,
      version: "1.1.0",
      adaptateur: adaptateurFactice({
        metriques: [{ nom: "accuracy_test", valeur: 0.5 }],
        hyperparams: {},
      }),
    });

    expect(rapport.etapes.evaluation.baselineVersion).toBe("1.0.0");
    expect(rapport.decision).toBe("quarantaine");
    expect(rapport.raisons.some((r) => r.includes("accuracy_test"))).toBe(true);
    expect(rapport.etapes.porte.canalFinal).toBe("experimental");
    expect(rapport.manifest?.channel).toBe("experimental");

    // La production n'a pas bougé ; le lignage relie 1.1.0 → 1.0.0.
    expect(
      (await registre.latest("gen3-cortex-v2", "production"))?.version,
    ).toBe("1.0.0");
    expect((await registre.get("gen3-cortex-v2", "1.1.0"))?.lineage.parentVersion).toBe("1.0.0");
    const chaine = (await registre.lineage("gen3-cortex-v2", "1.1.0")).map(
      (m) => m.version,
    );
    expect(chaine).toEqual(["1.1.0", "1.0.0"]);
  });

  it("porte fermée : dérive PSI au-delà du seuil → QUARANTAINE (usage inconnu en production)", async () => {
    const { registre, cheminArtefact } = environnement();

    const rapport = await executerPipeline({
      modelId: "gen3-cortex-v2",
      version: "1.0.0",
      registre,
      cheminArtefact,
      adaptateur: adaptateurFactice({
        metriques: [{ nom: "accuracy_test", valeur: 0.9 }],
        hyperparams: {},
      }),
      // Usage observé TOTALEMENT étranger à la distribution d'entraînement.
      collecteurDerive: { snapshot: () => ({ USAGE_INCONNU: 500 }) },
    });

    expect(rapport.etapes.evaluation.derive.psi).toBeGreaterThan(0.25);
    expect(rapport.etapes.evaluation.derive.statut).toBe("derive");
    expect(rapport.decision).toBe("quarantaine");
    expect(rapport.raisons.some((r) => r.includes("dérive PSI"))).toBe(true);
    expect(rapport.etapes.porte.canalFinal).toBe("experimental");
    // Métriques bonnes mais porte fermée : la version reste enregistrée
    // (inventaire des quarantaines) en canal experimental.
    expect(await registre.get("gen3-cortex-v2", "1.0.0")).not.toBeNull();
  });

  it("idempotence : relancer la MÊME version ne ré-entraîne pas et laisse le pointeur intact", async () => {
    const { registre, cheminArtefact, racine } = environnement();
    const communs = { modelId: "gen3-cortex-v2", registre, cheminArtefact, gitSha: "cfc052a6" as const };
    const adaptateur = adaptateurFactice({
      metriques: [{ nom: "accuracy_test", valeur: 0.9 }],
      hyperparams: {},
    });

    await executerPipeline({ ...communs, version: "1.0.0", adaptateur });
    const pointeurAvant = readFileSync(
      join(racine, "gen3-cortex-v2", "production.json"),
      "utf8",
    );

    const rapport = await executerPipeline({
      ...communs,
      version: "1.0.0",
      adaptateur,
    });

    expect(adaptateur.compteur.appels).toBe(0); // JAMAIS ré-entraîné
    expect(rapport.reprise).toBe(true);
    expect(rapport.decision).toBe("promotion");
    expect(rapport.etapes.entrainement.statut).toBe("reprise");
    expect(rapport.etapes.porte.canalFinal).toBe("production");

    // NO-OP strict : le pointeur (promuLe compris) est inchangé.
    const pointeurApres = readFileSync(
      join(racine, "gen3-cortex-v2", "production.json"),
      "utf8",
    );
    expect(pointeurApres).toBe(pointeurAvant);
  });

  it("re-gate d'une quarantaine : promotion SANS re-entraîner dès que l'usage redevient conforme", async () => {
    const { registre, cheminArtefact } = environnement();
    const communs = { modelId: "gen3-cortex-v2", registre, cheminArtefact, gitSha: "cfc052a6" as const };
    const adaptateur = adaptateurFactice({
      metriques: [{ nom: "accuracy_test", valeur: 0.9 }],
      hyperparams: {},
    });

    // v1.0.0 → production.
    await executerPipeline({ ...communs, version: "1.0.0", adaptateur });
    // v1.1.0 : métriques égales MAIS usage dérivé → quarantaine.
    const quarantaine = await executerPipeline({
      ...communs,
      version: "1.1.0",
      adaptateur,
      collecteurDerive: { snapshot: () => ({ USAGE_INCONNU: 500 }) },
    });
    expect(quarantaine.decision).toBe("quarantaine");
    const appelsApresQuarantaine = adaptateur.compteur.appels;

    // Reprise de v1.1.0 sans collecteur (usage redevenu inoffensif/absent) :
    // porte réévaluée → PROMOTION, sans le moindre ré-entraînement.
    const rapport = await executerPipeline({ ...communs, version: "1.1.0", adaptateur });

    expect(adaptateur.compteur.appels).toBe(appelsApresQuarantaine);
    expect(rapport.reprise).toBe(true);
    expect(rapport.decision).toBe("promotion");
    expect(rapport.etapes.porte.canalFinal).toBe("production");
    expect(
      (await registre.latest("gen3-cortex-v2", "production"))?.version,
    ).toBe("1.1.0");
  });

  it("entraînement en échec : quarantaine argumentée, AUCUN manifeste écrit", async () => {
    const { registre, cheminArtefact } = environnement();

    const rapport = await executerPipeline({
      modelId: "gen3-cortex-v2",
      version: "1.0.0",
      registre,
      cheminArtefact,
      adaptateur: adaptateurEnEchec("GPU indisponible"),
    });

    expect(rapport.decision).toBe("quarantaine");
    expect(rapport.raisons[0]).toContain("GPU indisponible");
    expect(rapport.etapes.entrainement.statut).toBe("echec");
    expect(rapport.etapes.entrainement.erreur).toContain("GPU indisponible");
    expect(rapport.etapes.porte.manifestVersion).toBeNull();
    expect(rapport.manifest).toBeNull();
    expect(await registre.get("gen3-cortex-v2", "1.0.0")).toBeNull();
  });

  it("artefact introuvable : quarantaine, aucun manifeste (rien à référencer)", async () => {
    const { registre, racine } = environnement();

    const rapport = await executerPipeline({
      modelId: "gen3-cortex-v2",
      version: "1.0.0",
      registre,
      cheminArtefact: join(racine, "absent.bin"),
      adaptateur: adaptateurFactice({
        metriques: [{ nom: "accuracy_test", valeur: 0.9 }],
        hyperparams: {},
      }),
    });

    expect(rapport.decision).toBe("quarantaine");
    expect(rapport.etapes.entrainement.statut).toBe("echec");
    expect(rapport.manifest).toBeNull();
    expect(await registre.get("gen3-cortex-v2", "1.0.0")).toBeNull();
  });

  it("seuilsMin : métrique nouvelle sous plancher déclaré → quarantaine", async () => {
    const { registre, cheminArtefact } = environnement();

    const rapport = await executerPipeline({
      modelId: "gen3-cortex-v2",
      version: "1.0.0",
      registre,
      cheminArtefact,
      seuilsMin: { accuracy_test: 0.7 },
      adaptateur: adaptateurFactice({
        metriques: [{ nom: "accuracy_test", valeur: 0.5 }],
        hyperparams: {},
      }),
    });

    expect(rapport.decision).toBe("quarantaine");
    expect(rapport.raisons.some((r) => r.includes("plancher déclaré"))).toBe(true);
    // Le plancher est reporté dans le manifeste (auditabilité).
    expect(rapport.manifest?.metrics[0]?.seuilMin).toBe(0.7);
  });
});
