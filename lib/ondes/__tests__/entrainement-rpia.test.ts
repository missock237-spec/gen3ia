import { describe, expect, it } from "vitest";

import { EntraineurRPIA } from "@/lib/ondes/entrainement-rpia";
import { BORNES_RPIA } from "@/lib/ondes/types-entrainement";

describe("entraîneur RPIA (miroir CPU du shader waveTrainer)", () => {
  it("déterminisme : même graine → mêmes poids initiaux et même trajectoire", () => {
    const cible = new Float32Array(64).map((_, i) => Math.sin(i * 0.05));
    const a = new EntraineurRPIA(64);
    const b = new EntraineurRPIA(64);
    expect(Array.from(a.exporterPoids())).toEqual(Array.from(b.exporterPoids()));

    const ra = a.entrainer(cible, 20);
    const rb = b.entrainer(cible, 20);
    expect(ra.historiqueErreur).toEqual(rb.historiqueErreur);
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
