import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  definirEntrepotCles,
  delivrerCleEntrainement,
  creerEntrepotClesFichiers,
} from "@/lib/training/cles-entrainement";
import {
  definirEntrepotModeles,
  creerEntrepotModelesFichiers,
} from "@/lib/training/registre-modeles";
import {
  entrainementCleStatutTool,
  entrainementDatasetCreerTool,
  entrainementModeleEntrainerTool,
  entrainementModeleRegistreTool,
  entrainementModeleTesterTool,
  mondeIaSeanceTool,
  outilsEntrainement,
} from "./outils";

const contexte = (userId: string) => ({ userId });

/**
 * OUTILS D'ENTRAÎNEMENT GEN3 (intégration, entrepôts FICHIER réels) :
 * le garde de clé est exercé AVANT toute exécution — refus honnête sans clé,
 * flux complets (dataset → entraîner+tester → monde virtuel) et flux de
 * PERSISTANCE (sauver → charger → re-tester : l'IA garde ce qu'elle a
 * appris entre les sessions). Aucun mock de logique métier.
 */
describe("outils entrainement — garde de clé (exigence facturation)", () => {
  beforeEach(() => {
    definirEntrepotCles(creerEntrepotClesFichiers(mkdtempSync(join(tmpdir(), "g3t-outils-"))));
    definirEntrepotModeles(creerEntrepotModelesFichiers(mkdtempSync(join(tmpdir(), "g3m-outils-"))));
  });

  it("tous les outils d'entraînement sont annoncés avec des déclencheurs PRÉCIS", () => {
    const ids = outilsEntrainement.map((t) => t.id);
    expect(ids).toEqual([
      "entrainement.cle.statut",
      "entrainement.dataset.creer",
      "entrainement.modele.entrainer",
      "entrainement.modele.tester",
      "entrainement.modele.registre",
      "monde.ia.seance",
    ]);
    expect(outilsEntrainement.every((t) => t.description.length > 80)).toBe(true);
    expect(outilsEntrainement.every((t) => /QUAND L'UTILISER|QUAND/.test(t.description))).toBe(true);
  });

  it("entrainement.dataset.creer SANS clé valable → REFUS AVANT toute génération", async () => {
    const resultat = await entrainementDatasetCreerTool.execute(
      { cle: "g3t_standard_inconnue_0000000000000000", famille: "langage", nombre: 20 },
      contexte("utilisateur-1"),
    );
    expect(resultat.autorise).toBe(false);
    expect(resultat.raison).toMatch(/inconnue pour ce compte/);
    expect(resultat.remediation).toMatch(/\/api\/training\/keys/);
    expect(resultat.dataset).toBeUndefined();
  });

  it("entrainement.modele.entrainer SANS clé → refus, zéro exécution d'entraînement", async () => {
    const resultat = await entrainementModeleEntrainerTool.execute(
      {
        cle: "g3t_standard_inconnue_0000000000000000",
        modele: { famille: "tenseur-mlp", architecture: { entrees: 2, caches: [8], sorties: 3 } },
        synthetique: { famille: "classification", nombre: 100, graine: 1 },
      },
      contexte("utilisateur-1"),
    );
    expect(resultat.autorise).toBe(false);
    expect(resultat.details).toMatch(/refusé AVANT toute exécution/);
  });

  it("flux COMPLET avec clé délivrée : dataset synthétique → entraînement → test interne conforme", async () => {
    const { cle } = await delivrerCleEntrainement({
      userId: "utilisateur-1",
      niveau: "standard",
      planId: "pro",
      planActif: true,
    });
    const dataset = await entrainementDatasetCreerTool.execute(
      { cle, famille: "langage", nombre: 60, graine: 2026 },
      contexte("utilisateur-1"),
    );
    expect(dataset.autorise).toBe(true);
    expect(dataset.dataset?.elements).toBe(60);
    expect(dataset.dataset?.contenuTronque).toBe(false);

    const entrainement = await entrainementModeleEntrainerTool.execute(
      {
        cle,
        modele: { famille: "cortex-langagier", graine: 2026 },
        synthetique: { famille: "langage", nombre: 120, graine: 2026, theme: "session" },
        ratioTest: 0.25,
      },
      contexte("utilisateur-1"),
    );
    expect(entrainement.autorise).toBe(true);
    expect(entrainement.niveauUtilise).toBe("standard");
    expect(entrainement.famille).toBe("cortex-langagier");
    expect(entrainement.banc?.verdict).toBe("conforme");
    expect(entrainement.entrainement?.convergence).toBe(true);
    expect(entrainement.export?.octets).toBeGreaterThan(0);
  }, 60_000);

  it("test interne pur : modèle fourni avec poids, évalué sans entraînement", async () => {
    const { cle } = await delivrerCleEntrainement({
      userId: "utilisateur-1",
      niveau: "standard",
      planId: "pro",
      planActif: true,
    });
    const resultat = await entrainementModeleTesterTool.execute(
      {
        cle,
        modele: {
          famille: "tenseur-mlp",
          architecture: { entrees: 2, caches: [6], sorties: 2 },
          poids: Array.from({ length: 2 * 6 + 6 + 6 * 2 + 2 }, (_, i) => Math.cos(i * 1.7) * 0.2),
        },
        donnees: { classification: [{ entrees: [0, 0], label: "classe-1" }, { entrees: [9, 9], label: "classe-2" }] },
      },
      contexte("utilisateur-1"),
    );
    expect(resultat.autorise).toBe(true);
    expect(resultat.score).not.toBeNull();
    expect(["conforme", "insuffisant"]).toContain(resultat.verdict);
    expect(resultat.metriques?.length).toBeGreaterThan(0);
  });

  it("monde.ia.seance avec clé standard → séance complète, progression mesurée", async () => {
    const { cle } = await delivrerCleEntrainement({
      userId: "utilisateur-1",
      niveau: "standard",
      planId: "pro",
      planActif: true,
    });
    const resultat = await mondeIaSeanceTool.execute(
      { cle, graine: 2026, taille: 10, episodes: 20 },
      contexte("utilisateur-1"),
    );
    expect(resultat.autorise).toBe(true);
    expect(resultat.niveauRequis).toBe("standard");
    expect(resultat.rapport?.leconsGen3).toBeGreaterThan(10);
    expect(resultat.rapport?.verdict).toBe("progres");
    expect(resultat.ressources?.parametresPolitique).toBeGreaterThan(100);
  }, 60_000);

  it("monde.ia.seance : séance au-delà du plafond du niveau → refus HONNÊTE", async () => {
    const { cle } = await delivrerCleEntrainement({
      userId: "utilisateur-1",
      niveau: "standard",
      planId: "pro",
      planActif: true,
    });
    const resultat = await mondeIaSeanceTool.execute(
      { cle, episodes: 400 },
      contexte("utilisateur-1"),
    );
    expect(resultat.autorise).toBe(false);
    expect(resultat.niveauRequis).toBe("integral");
    expect(resultat.raison).toMatch(/insuffisante pour « integral »/);
  });

  it("entrainement.cle.statut : sans clé → démarche d'obtention ; avec clé → capacités", async () => {
    const sansCle = await entrainementCleStatutTool.execute({}, contexte("utilisateur-1"));
    expect(sansCle.autorise).toBe(false);
    expect(sansCle.remediation).toMatch(/POST \/api\/training\/keys/);
    expect(sansCle.niveauxExistants).toEqual(["standard", "avance", "integral"]);

    const { cle } = await delivrerCleEntrainement({
      userId: "utilisateur-1",
      niveau: "standard",
      planId: "pro",
      planActif: true,
    });
    const avecCle = await entrainementCleStatutTool.execute({ cle }, contexte("utilisateur-1"));
    expect(avecCle.autorise).toBe(true);
    expect(avecCle.capacites?.parametresMax).toBeGreaterThan(0);
  });

  it("données manquantes (ni donnees ni synthetique) : erreur honnête, pas de crash", async () => {
    const { cle } = await delivrerCleEntrainement({
      userId: "utilisateur-1",
      niveau: "standard",
      planId: "pro",
      planActif: true,
    });
    const resultat = await entrainementModeleEntrainerTool.execute(
      { cle, modele: { famille: "tenseur-mlp" } },
      contexte("utilisateur-1"),
    );
    expect(resultat.details).toMatch(/Aucune donnée fournie/);
  });

  it("flux PERSISTANT : entraîner+sauver → lister → charger → RE-TESTER le modèle restauré", async () => {
    const { cle } = await delivrerCleEntrainement({
      userId: "utilisateur-1",
      niveau: "standard",
      planId: "pro",
      planActif: true,
    });
    const { paires } = await import("@/lib/training/synthetique").then((m) => m.genererPairesLangage({ nombre: 90, graine: 333 }));
    const entrainement = await entrainementModeleEntrainerTool.execute(
      {
        cle,
        modele: { famille: "cortex-langagier", graine: 2026 },
        donnees: { langage: paires },
        ratioTest: 0.25,
        sauverSous: "assistant-support-v1",
      },
      contexte("utilisateur-1"),
    );
    expect(entrainement.autorise).toBe(true);
    expect(entrainement.banc?.verdict).toBe("conforme");
    expect(entrainement.modelId).toMatch(/^mdl-/);

    const liste = await entrainementModeleRegistreTool.execute(
      { cle, action: "lister" },
      contexte("utilisateur-1"),
    );
    expect(liste.autorise).toBe(true);
    expect(liste.modeles).toHaveLength(1);
    expect(liste.modeles?.[0].nom).toBe("assistant-support-v1");
    expect(liste.modeles?.[0].bancVerdict).toBe("conforme");

    const charge = await entrainementModeleRegistreTool.execute(
      { cle, action: "charger", modelId: entrainement.modelId },
      contexte("utilisateur-1"),
    );
    expect(charge.autorise).toBe(true);
    const modeleFourni = charge.modele?.modeleFourni as { famille: string; etatLangage: object };
    expect(modeleFourni.famille).toBe("cortex-langagier");
    expect(modeleFourni.etatLangage).toBeDefined();

    // Le modèle restauré est RE-TESTÉ : il retient exactement ce qu'il a appris.
    const retest = await entrainementModeleTesterTool.execute(
      { cle, modele: modeleFourni as never, donnees: { langage: paires.slice(0, 20) } },
      contexte("utilisateur-1"),
    );
    expect(retest.autorise).toBe(true);
    expect(retest.score).toBeGreaterThanOrEqual(0.9);

    // Suppression : le propriétaire maîtrise son registre.
    const suppression = await entrainementModeleRegistreTool.execute(
      { cle, action: "supprimer", modelId: entrainement.modelId },
      contexte("utilisateur-1"),
    );
    expect(suppression.details).toMatch(/supprimé/);
  }, 60_000);

  it("monde virtuel : séance 1 SAUVE la politique → séance 2 la recharge (l'IA garde ce qu'elle a appris)", async () => {
    const { cle } = await delivrerCleEntrainement({
      userId: "utilisateur-1",
      niveau: "standard",
      planId: "pro",
      planActif: true,
    });
    const seance1 = await mondeIaSeanceTool.execute(
      { cle, graine: 2026, taille: 10, episodes: 20, sauverSous: "politique-monde-v1" },
      contexte("utilisateur-1"),
    );
    expect(seance1.autorise).toBe(true);
    expect(seance1.modelId).toMatch(/^mdl-/);
    expect(seance1.rapport?.fragmentsMoyensApres).toBeGreaterThan(0);

    const charge = await entrainementModeleRegistreTool.execute(
      { cle, action: "charger", modelId: seance1.modelId },
      contexte("utilisateur-1"),
    );
    const modeleFourni = charge.modele?.modeleFourni as { famille: string; poids: number[]; biais: number[] };
    expect(modeleFourni.famille).toBe("tenseur-mlp");
    expect(modeleFourni.poids?.length).toBeGreaterThan(0);

    // Séance 2 AVEC la politique restaurée : dès la mesure de référence (IA
    // « brute » du monde), elle collecte — la mémoire a survécu à la session.
    const seance2 = await mondeIaSeanceTool.execute(
      { cle, graine: 2026, taille: 10, episodes: 20, modeleFourni },
      contexte("utilisateur-1"),
    );
    expect(seance2.autorise).toBe(true);
    expect(seance2.rapport?.recompenseAvant).toBeGreaterThan(-10); // vs ≈ -32 pour une IA vierge
  }, 120_000);
});
