import { describe, expect, it } from "vitest";

import {
  actionExpert,
  ACTIONS_MONDE,
  creerMondeVirtuel,
  executerEpisode,
  genererLeconsGen3,
  niveauRequisPourSeance,
  ressourcesSeanceMonde,
  seanceApprentissageMonde,
  verifierCapaciteMonde,
} from "./arene-ia";
import { adapterPour } from "@/lib/training/adaptateurs-ia";

/**
 * MONDE VIRTUEL POUR IA — l'IA S'EXÉCUTE (épisodes réels) et APPREND ce que
 * gen3 lui enseigne (démonstrations expertes BFS + renforcement léger).
 * Monde DÉTERMINISTE et plafonné par le niveau de clé (facturation).
 */
describe("monde virtuel — création et physique de grille", () => {
  it("déterminisme : même graine → même monde (murs, fragments)", () => {
    const a = creerMondeVirtuel({ graine: 7, taille: 12 });
    const b = creerMondeVirtuel({ graine: 7, taille: 12 });
    expect([...a.murs]).toEqual([...b.murs]);
    expect([...a.fragments.keys()]).toEqual([...b.fragments.keys()]);
    const c = creerMondeVirtuel({ graine: 8, taille: 12 });
    expect([...c.murs]).not.toEqual([...a.murs]);
  });

  it("garde-fous : départ libre, taille plafonnée, fragments atteignables par BFS", () => {
    const monde = creerMondeVirtuel({ graine: 3, taille: 12 });
    expect(monde.murs.has("0,0")).toBe(false);
    const gros = creerMondeVirtuel({ graine: 3, taille: 500 });
    expect(gros.taille).toBeLessThanOrEqual(20);
    // Chaque pas expert est légal (jamais dans un mur ni hors monde).
    const action = actionExpert(monde);
    expect(action).not.toBeNull();
    expect(ACTIONS_MONDE).toContain(action as never);
  });
});

describe("monde virtuel — leçons gen3 (curriculum expert BFS)", () => {
  it("génère des leçons (observation → action) valides et reproductibles", () => {
    const monde = creerMondeVirtuel({ graine: 11, taille: 10 });
    const lecons = genererLeconsGen3(monde);
    expect(lecons.length).toBeGreaterThan(10);
    for (const lecon of lecons) {
      expect(lecon.entrees).toHaveLength(13); // vision 3×3 (9) + position (2) + boussole (2)
      expect(lecon.label).toMatch(/^action-[0-3]$/);
    }
    const mondeBis = creerMondeVirtuel({ graine: 11, taille: 10 });
    const leconsBis = genererLeconsGen3(mondeBis);
    expect(leconsBis.map((l) => l.label)).toEqual(lecons.map((l) => l.label));
  });

  it("leçons APRÈS épisodes productifs : le monde est réinitialisé avant de compter", async () => {
    // Scénario du bug corrigé : une politique entraînée collecte TOUS les
    // fragments pendant ses épisodes de référence — le curriculum doit
    // quand même exister (réinitialisation AVANT le comptage des fragments).
    const monde = creerMondeVirtuel({ graine: 11, taille: 10 });
    const leconsAvant = genererLeconsGen3(monde);
    const politique = adapterPour({ famille: "tenseur-mlp", architecture: { entrees: 13, caches: [12], sorties: 4 }, graine: 11 });
    await politique.entrainer({ classification: leconsAvant }, { epoques: 80 });
    // Épisodes qui consomment le monde (collecte de tous les fragments).
    for (let i = 0; i < 2; i += 1) {
      await executerEpisode(monde, (entrees) => politique.inference!(entrees), { pasMax: 160 });
    }
    const leconsApres = genererLeconsGen3(monde);
    expect(leconsApres.length).toBe(leconsAvant.length); // le monde repart vierge
    expect(leconsApres.length).toBeGreaterThan(10);
  }, 30_000);
});

describe("monde virtuel — exécution d'IA (épisodes réels)", () => {
  it("épisode borné : pasMax respecté, récompense plafonnée par les fragments du monde", async () => {
    const monde = creerMondeVirtuel({ graine: 5, taille: 8 });
    const adaptateur = adapterPour({ famille: "tenseur-mlp", architecture: { entrees: 13, caches: [12], sorties: 4 }, graine: 5 });
    const trajectoire = await executerEpisode(monde, (entrees) => adaptateur.inference!(entrees), { pasMax: 30 });
    expect(trajectoire.pas).toBeLessThanOrEqual(30);
    expect(trajectoire.recompense).toBeLessThanOrEqual(2.5); // ≤ fragments disponibles, jamais inflation
    expect(trajectoire.decisions).toHaveLength(trajectoire.pas);
  });
});

describe("monde virtuel — séance complète : apprend ce que gen3 enseigne", () => {
  it("progression MESURÉE : récompense et fragments collectés après leçons gen3", async () => {
    const { rapport } = await seanceApprentissageMonde({ graine: 2026, taille: 10, episodes: 20, niveau: "standard" });
    expect(rapport.leconsGen3).toBeGreaterThan(10);
    expect(rapport.episodes).toBe(20);
    expect(rapport.verdict).toBe("progres");
    expect(rapport.recompenseApres).toBeGreaterThan(rapport.recompenseAvant);
    expect(rapport.tauxReussiteApres).toBeGreaterThanOrEqual(rapport.tauxReussiteAvant);
    expect(rapport.fragmentsMoyensApres).toBeGreaterThan(0); // l'IA collecte réellement après leçons
  }, 60_000);

  it("garde de capacité : épisodes au-delà du plafond refusés honnêtement", () => {
    const verdict = verifierCapaciteMonde("standard", { episodes: 500, taille: 12 });
    expect(verdict.autorise).toBe(false);
    expect(verdict.raison).toMatch(/plafond du niveau « standard »/);
    const ok = verifierCapaciteMonde("standard", { episodes: 50, taille: 12 });
    expect(ok.autorise).toBe(true);
  });

  it("niveau requis par la taille de la séance (facturation → capacités)", () => {
    expect(niveauRequisPourSeance(40)).toBe("standard");
    expect(niveauRequisPourSeance(150)).toBe("avance");
    expect(niveauRequisPourSeance(600)).toBe("integral");
  });

  it("estimation de ressources honnête (mémoire/CPU non nuls, bornés)", () => {
    const r = ressourcesSeanceMonde({ taille: 12, episodes: 40, pasMax: 160 });
    expect(r.parametresPolitique).toBeGreaterThan(100);
    expect(r.memoireMoEstimee).toBeGreaterThan(0);
    expect(r.cpuMsEstime).toBeGreaterThan(0);
  });
});
