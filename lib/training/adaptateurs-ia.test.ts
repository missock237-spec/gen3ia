import { describe, expect, it } from "vitest";

import {
  adapterPour,
  modeleFourniDepuisContenu,
  estimerRessourcesModele,
  niveauCouvre,
  niveauRequisPourParametres,
} from "./adaptateurs-ia";
import { genererCiblesOnde, genererExemplesClassification, genererPairesLangage } from "./synthetique";

/**
 * ADAPTATEURS D'ENTRAÎNEMENT — gen3 s'adapte au système neuronal du modèle
 * fourni. Chaque famille est entraînée RÉELLEMENT (CPU) et évaluée sur des
 * données : aucun score sans exécution. Les allers-retours export →
 * restauration sont vérifiés EXACTS (registre des modèles entraînés).
 */
describe("adaptateurs-ia — tenseur-mlp (rétropropagation réelle)", () => {
  it("apprend des clusters synthétiques et converge (perte qui baisse)", async () => {
    const { exemples } = genererExemplesClassification({ nombre: 240, classes: 3, dimensions: 2, graine: 31 });
    const adaptateur = adapterPour({ famille: "tenseur-mlp", architecture: { entrees: 2, caches: [10], sorties: 3 }, graine: 31 });
    const rapport = await adaptateur.entrainer({ classification: exemples }, { epoques: 120 });
    expect(rapport.convergence).toBe(true);
    expect(rapport.erreurFinale).toBeLessThan(rapport.erreurInitiale);
    expect(rapport.historiqueErreur).toHaveLength(120);
  });

  it("exactitude sur données jamais vues ≥ 0.85 (clusters séparables)", async () => {
    const { exemples } = genererExemplesClassification({ nombre: 300, classes: 3, dimensions: 2, graine: 55 });
    const train = exemples.filter((_, i) => i % 2 === 1);
    const test = exemples.filter((_, i) => i % 2 === 0);
    const adaptateur = adapterPour({ famille: "tenseur-mlp", architecture: { entrees: 2, caches: [10], sorties: 3 }, graine: 55 });
    await adaptateur.entrainer({ classification: train }, { epoques: 150 });
    const evaluation = await adaptateur.evaluer({ classification: test });
    expect(evaluation.exactitude).not.toBeNull();
    expect(evaluation.exactitude as number).toBeGreaterThanOrEqual(0.85);
  });

  it("modèle fourni AVEC poids : évaluable avant tout entraînement", async () => {
    const { exemples } = genererExemplesClassification({ nombre: 30, classes: 2, dimensions: 2, graine: 12 });
    const adaptateur = adapterPour({
      famille: "tenseur-mlp",
      architecture: { entrees: 2, caches: [6], sorties: 2 },
      poids: Array.from({ length: 2 * 6 + 6 + 6 * 2 + 2 }, (_, i) => Math.sin(i) * 0.1),
      graine: 12,
    });
    const evaluation = await adaptateur.evaluer({ classification: exemples });
    expect(evaluation.echantillons).toBe(30);
    expect(evaluation.exactitude).toBeGreaterThanOrEqual(0);
    const scores = await adaptateur.inference?.(exemples[0].entrees);
    expect(scores).toHaveLength(2);
  });

  it("exporter : contenu complet (architecture + poids + biais + labels) restaurable", async () => {
    const adaptateur = adapterPour({ famille: "tenseur-mlp", architecture: { entrees: 3, caches: [8], sorties: 2 }, graine: 1 });
    const { exemples } = genererExemplesClassification({ nombre: 20, classes: 2, dimensions: 3, graine: 1 });
    await adaptateur.entrainer({ classification: exemples }, { epoques: 10 });
    const exportation = adaptateur.exporter();
    expect(exportation.format).toBe("json");
    expect(exportation.octets).toBeGreaterThan(50);
    const contenu = JSON.parse(exportation.contenu) as { famille: string; poids: number[]; biais: number[]; labels: string[] };
    expect(contenu.famille).toBe("tenseur-mlp");
    expect(contenu.poids.length).toBeGreaterThan(0);
    expect(contenu.biais.length).toBeGreaterThan(0);
    expect(contenu.labels.length).toBeGreaterThan(0);
  });

  it("aller-retour EXACT : entraîner → exporter → restaurer → mêmes prédictions", async () => {
    const { exemples } = genererExemplesClassification({ nombre: 200, classes: 3, dimensions: 2, graine: 66 });
    const original = adapterPour({ famille: "tenseur-mlp", architecture: { entrees: 2, caches: [10], sorties: 3 }, graine: 66 });
    await original.entrainer({ classification: exemples }, { epoques: 120 });
    const restaure = adapterPour(modeleFourniDepuisContenu(original.exporter().contenu, 66));
    const evalOriginal = await original.evaluer({ classification: exemples.slice(0, 40) });
    const evalRestaure = await restaure.evaluer({ classification: exemples.slice(0, 40) });
    expect(evalRestaure.exactitude).toBe(evalOriginal.exactitude); // restauration bit-exacte
    expect(evalRestaure.exactitude).toBeGreaterThanOrEqual(0.85);
  });
});

describe("adaptateurs-ia — cortex-langagier (mémoire résonante gen3)", () => {
  it("apprend des paires synthétiques et les rappelle exactement", async () => {
    const { paires } = genererPairesLangage({ nombre: 40, graine: 2026 });
    const adaptateur = adapterPour({ famille: "cortex-langagier", graine: 2026 });
    const rapport = await adaptateur.entrainer({ langage: paires }, { epoques: 1 });
    expect(rapport.convergence).toBe(true);
    expect(rapport.erreurFinale).toBeLessThan(rapport.erreurInitiale);
    const evaluation = await adaptateur.evaluer({ langage: paires.slice(0, 20) });
    expect(evaluation.exactitude).toBeGreaterThanOrEqual(0.9);
    const exportation = adaptateur.exporter();
    expect(exportation.format).toBe("json");
    expect(exportation.octets).toBeGreaterThan(0);
  });

  it("aller-retour EXACT : entraîner → exporter → restaurer → même rappel", async () => {
    const { paires } = genererPairesLangage({ nombre: 50, graine: 77 });
    const original = adapterPour({ famille: "cortex-langagier", graine: 2026 });
    await original.entrainer({ langage: paires }, { epoques: 1 });
    const restaure = adapterPour(modeleFourniDepuisContenu(original.exporter().contenu, 2026));
    const evalOriginal = await original.evaluer({ langage: paires });
    const evalRestaure = await restaure.evaluer({ langage: paires });
    expect(evalRestaure.exactitude).toBe(evalOriginal.exactitude);
    expect(evalRestaure.exactitude).toBeGreaterThanOrEqual(0.9); // l'état du cortex revient intact
  });
});

describe("adaptateurs-ia — onde-rpia (interférence, miroir WebGPU)", () => {
  it("converge sur une cible unique et mesure l'apprentissabilité des nouvelles", async () => {
    const { cibles } = genererCiblesOnde({ nombre: 10, noeuds: 64, graine: 404 });
    const adaptateur = adapterPour({ famille: "onde-rpia", noeuds: 64, graine: 404 });
    // Convergence : une cible, net dédié — la courbe d'erreur baisse réellement.
    const rapport = await adaptateur.entrainer({ onde: [cibles[0]] }, { epoques: 30 });
    expect(rapport.convergence).toBe(true);
    expect(rapport.erreurFinale).toBeLessThan(rapport.erreurInitiale);
    // Apprentissabilité : cibles JAMAIS vues, entraîneur neuf par cible.
    const evaluation = await adaptateur.evaluer({ onde: cibles.slice(8) }, { pasParCible: 12 });
    expect(evaluation.metriques).toHaveLength(2);
    expect(evaluation.metriques[0].valeur).toBeGreaterThanOrEqual(0);
    const exportation = adaptateur.exporter();
    expect(exportation.format).toBe("json");
    const contenu = JSON.parse(exportation.contenu) as { noeuds: number; poids: number[] };
    expect(contenu.noeuds).toBe(64);
    expect(contenu.poids).toHaveLength(64 * 4); // [amplitude, fréquence, phase, amortissement] × 64
  });

  it("aller-retour EXACT : entraîner → exporter → restaurer → mêmes nœuds d'onde", async () => {
    const { cibles } = genererCiblesOnde({ nombre: 5, noeuds: 32, graine: 909 });
    const original = adapterPour({ famille: "onde-rpia", noeuds: 32, graine: 909 });
    await original.entrainer({ onde: [cibles[0]] }, { epoques: 25 });
    const poidsOriginal = (JSON.parse(original.exporter().contenu) as { poids: number[] }).poids;
    const restaure = adapterPour(modeleFourniDepuisContenu(original.exporter().contenu, 909));
    const poidsRestaure = (JSON.parse(restaure.exporter().contenu) as { poids: number[] }).poids;
    expect(poidsRestaure).toEqual(poidsOriginal); // restauration bit-exacte
  });
});

describe("adaptateurs-ia — ressources et garde de niveau (facturation)", () => {
  it("estimation préflight par famille + niveau requis par paramètres", () => {
    const mlp = estimerRessourcesModele({ famille: "tenseur-mlp", architecture: { entrees: 15, caches: [12], sorties: 4 } });
    expect(mlp.parametres).toBe(15 * 12 + 12 + 12 * 4 + 4);
    expect(mlp.niveauRequis).toBe("standard");
    const gros = estimerRessourcesModele({ famille: "tenseur-mlp", architecture: { entrees: 4096, caches: [2048], sorties: 2048 } });
    expect(gros.niveauRequis).toBe("integral");
    expect(niveauRequisPourParametres(49_000)).toBe("standard");
    expect(niveauRequisPourParametres(400_000)).toBe("avance");
    expect(niveauRequisPourParametres(4_000_000)).toBe("integral");
  });

  it("niveauCouvre : refuse au-delà des capacités du niveau", () => {
    const petit = estimerRessourcesModele({ famille: "tenseur-mlp" });
    const moyen = estimerRessourcesModele({ famille: "tenseur-mlp", architecture: { entrees: 1024, caches: [1024], sorties: 512 } });
    expect(niveauCouvre("standard", petit)).toBe(true);
    expect(niveauCouvre("standard", moyen)).toBe(false);
    expect(niveauCouvre("integral", moyen)).toBe(true);
  });

  it("famille inconnue / contenu illisible : erreurs honnêtes", () => {
    expect(() => adapterPour({ famille: "inconnue" as never })).toThrow(/Famille de modèle inconnue/);
    expect(() => modeleFourniDepuisContenu("pas-du-json")).toThrow(/illisible/);
    expect(() => modeleFourniDepuisContenu(JSON.stringify({ famille: "bizarre" }))).toThrow(/Famille de modèle absente/);
  });
});
