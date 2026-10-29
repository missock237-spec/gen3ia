import { describe, expect, it } from "vitest";

import { EntraineurRPIA } from "@/lib/ondes/entrainement-rpia";
import { SHADER_ENTRAINEMENT_RPIA } from "@/lib/ondes/shaders-rpia";
import {
  BORNES_RPIA,
  calculerTempsGlobalRPIA,
  validerCibleRPIA,
  validerConfigRPIA,
} from "@/lib/ondes/types-entrainement";

describe("entraîneur RPIA (miroir CPU du shader waveTrainer)", () => {
  it("CPU et shader partagent une horloge globale explicite par pas", () => {
    const config = { tauxApprentissage: 0.01, pasDeTemps: 0.1 };
    expect(calculerTempsGlobalRPIA(config, 0)).toBe(0);
    expect(calculerTempsGlobalRPIA(config, 1)).toBeCloseTo(0.1, 7);
    expect(calculerTempsGlobalRPIA(config, 2)).toBeCloseTo(0.2, 7);
    expect(() => calculerTempsGlobalRPIA(config, Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /Compteur de pas RPIA invalide/,
    );
  });

  it("refuse les cibles et configurations non représentables en float32", () => {
    expect(() => validerCibleRPIA(new Float32Array(3), 4)).toThrow(/Cible incompatible/);
    expect(() => validerCibleRPIA(new Float32Array([0.1, 0.2, Number.NaN, 0.4]), 4)).toThrow(
      /Cible non finie/,
    );
    expect(() => validerCibleRPIA([1e100, 0, 0, 0], 4)).toThrow(/float32/);
    expect(() => validerConfigRPIA({ tauxApprentissage: 1e100, pasDeTemps: 0.1 })).toThrow(
      /float32/,
    );
    expect(() => validerConfigRPIA({ tauxApprentissage: 0.01, pasDeTemps: 1e-50 })).toThrow(
      /float32/,
    );
  });

  it("le shader protège la dernière tranche d'un dispatch non multiple de 256", () => {
    expect(SHADER_ENTRAINEMENT_RPIA).toContain("if (idx >= arrayLength(&noeuds)) { return; }");
    expect(SHADER_ENTRAINEMENT_RPIA).toContain("parametres.tempsGlobal");
    expect(SHADER_ENTRAINEMENT_RPIA).not.toContain("parametres.pasDeTemps");
  });

  it("déterminisme : même graine → mêmes poids initiaux et même trajectoire", () => {
    const cible = new Float32Array(64).map((_, i) => Math.sin(i * 0.05));
    const a = new EntraineurRPIA(64);
    const b = new EntraineurRPIA(64);
    expect(Array.from(a.exporterPoids())).toEqual(Array.from(b.exporterPoids()));

    const ra = a.entrainer(cible, 20);
    const rb = b.entrainer(cible, 20);
    expect(ra.historiqueErreur).toEqual(rb.historiqueErreur);
  });

  it("mesure l'erreur initiale avant le premier pas (et non après)", () => {
    const entraineur = new EntraineurRPIA(64);
    const cible = new Float32Array(64).map((_, i) => Math.cos(i * 0.07));
    const tempsInitial = 0.1 * entraineur.pasTotaux;
    const erreurAvant = entraineur.erreurCourante(cible, tempsInitial);

    const rapport = entraineur.entrainer(cible, 10);

    expect(rapport.erreurInitiale).toBeCloseTo(erreurAvant, 12);
    expect(rapport.historiqueErreur).toHaveLength(10);
    expect(rapport.erreurFinale).toBeCloseTo(rapport.historiqueErreur[9]!, 12);
  });

  it("convergence réelle : l'erreur d'interférence décroît (courbe honnête)", () => {
    const n = 256;
    const entraineur = new EntraineurRPIA(n);
    const cible = new Float32Array(n).map((_, i) => Math.sin(i * 0.05));
    const rapport = entraineur.entrainer(cible, 200);

    expect(rapport.epoques).toBe(200);
    expect(rapport.historiqueErreur).toHaveLength(200);
    expect(rapport.erreurFinale).toBeLessThan(rapport.erreurInitiale);
    expect(rapport.convergence).toBe(true);
    // L'erreur ne peut pas devenir négative (moyenne de valeurs absolues).
    expect(rapport.erreurFinale).toBeGreaterThanOrEqual(0);
  });

  it("export des poids au format fidèle : [amplitude, fréquence, phase, amortissement] × N", () => {
    const entraineur = new EntraineurRPIA(1024);
    const poids = entraineur.exporterPoids();
    expect(poids).toHaveLength(1024 * 4); // contrat de la source gen3TestSuite
  });

  it("bornes physiques jamais franchies (amplitude [0, 2], amortissement [0.001, 0.5])", () => {
    const entraineur = new EntraineurRPIA(128);
    // Cible extrême : force les corrections maximales sur tous les nœuds.
    const cible = new Float32Array(128).fill(2);
    entraineur.entrainer(cible, 50);
    for (const noeud of entraineur.etat()) {
      expect(noeud.amplitude).toBeGreaterThanOrEqual(BORNES_RPIA.amplitudeMin);
      expect(noeud.amplitude).toBeLessThanOrEqual(BORNES_RPIA.amplitudeMax);
      expect(noeud.amortissement).toBeGreaterThanOrEqual(BORNES_RPIA.amortissementMin);
      expect(noeud.amortissement).toBeLessThanOrEqual(BORNES_RPIA.amortissementMax);
      expect(Number.isFinite(noeud.phase)).toBe(true);
    }
  });

  it("import/export : les poids réinjectés reproduisent l'état exact", () => {
    const cible = new Float32Array(64).map((_, i) => Math.cos(i * 0.1));
    const source = new EntraineurRPIA(64);
    source.entrainer(cible, 30);
    const poids = source.exporterPoids();

    const copie = new EntraineurRPIA(64);
    copie.importerPoids(poids);
    expect(Array.from(copie.exporterPoids())).toEqual(Array.from(poids));
    // Poids en f32 : reprise quasi identique (précision 1e-6 vérifiée).
    expect(copie.erreurCourante(cible, 0.1)).toBeCloseTo(source.erreurCourante(cible, 0.1), 6);
  });

  it("refuse une amplitude initiale non finie ou hors bornes physiques", () => {
    expect(() => new EntraineurRPIA(8, { amplitudeInitiale: Number.NaN })).toThrow(
      /Amplitude initiale invalide/,
    );
    expect(() => new EntraineurRPIA(8, { amplitudeInitiale: 2.1 })).toThrow(
      /Amplitude initiale invalide/,
    );
  });

  it("refuse les poids corrompus sans modifier partiellement le réseau", () => {
    const entraineur = new EntraineurRPIA(8);
    const avant = Array.from(entraineur.exporterPoids());
    const corrompus = entraineur.exporterPoids();
    corrompus[5] = Number.NaN;

    expect(() => entraineur.importerPoids(corrompus)).toThrow(/Poids RPIA non fini/);
    expect(Array.from(entraineur.exporterPoids())).toEqual(avant);

    const debordementF32 = entraineur.exporterPoids();
    debordementF32[1] = Number.POSITIVE_INFINITY;
    expect(() => entraineur.importerPoids(debordementF32)).toThrow(/Poids RPIA non fini/);
  });

  it("refuse une configuration d'ondes non finie ou physiquement invalide", () => {
    const entraineur = new EntraineurRPIA(8);
    const cible = new Float32Array(8).fill(0.25);
    expect(() => entraineur.pasEntrainement(cible, { tauxApprentissage: Number.NaN, pasDeTemps: 0.1 })).toThrow(
      /Configuration RPIA invalide/,
    );
    expect(() => entraineur.pasEntrainement(cible, { tauxApprentissage: 0.01, pasDeTemps: 0 })).toThrow(
      /Configuration RPIA invalide/,
    );
  });

  it("rejette proprement les entrées invalides (taille de cible, époques, nœuds)", () => {
    const entraineur = new EntraineurRPIA(32);
    expect(() => entraineur.entrainer(new Float32Array(16), 5)).toThrow(/Cible incompatible/);
    expect(() => entraineur.entrainer(new Float32Array(32), 0)).toThrow(/époques invalide/);
    expect(() => entraineur.entrainer(new Float32Array(32), 2.5)).toThrow(/époques invalide/);
    expect(() => new EntraineurRPIA(0)).toThrow(/Nombre de nœuds invalide/);
    // Valeurs non finies dans la cible : refus (la physique ne les tolère pas).
    const cibleNan = new Float32Array(32);
    cibleNan[7] = NaN;
    expect(() => entraineur.pasEntrainement(cibleNan)).toThrow(/non finie/);
  });
});
