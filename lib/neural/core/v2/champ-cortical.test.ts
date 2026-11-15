import { describe, expect, it } from "vitest";

import {
  ChampCorticalGen3,
  NEURONES_PAR_REGION,
  REGIONS,
  TAILLE_CHAMP,
} from "./champ-cortical";

describe("ChampCorticalGen3 (1 milliard de neurones adressables)", () => {
  it("déclare exactement 1 000 000 000 de neurones en treillis 1000³", () => {
    expect(TAILLE_CHAMP).toBe(1_000_000_000);
    expect(REGIONS).toBe(1000);
    expect(NEURONES_PAR_REGION).toBe(1_000_000);
    expect(TAILLE_CHAMP / REGIONS).toBe(NEURONES_PAR_REGION);
  });

  it("calcule un état d'onde réel, déterministe et borné pour tout neurone", () => {
    const champ = new ChampCorticalGen3(42);
    const a = champ.etatNeurone(123_456_789, 10);
    const b = champ.etatNeurone(123_456_789, 10);
    expect(b.frequence).toBe(a.frequence);
    expect(b.phase).toBe(a.phase);
    expect(b.amplitude).toBe(a.amplitude);
    expect(a.region).toBe(123);
    expect(a.frequence).toBeGreaterThanOrEqual(0.25);
    expect(a.frequence).toBeLessThanOrEqual(1.75);
    expect(a.amplitude).toBeGreaterThanOrEqual(0);
    // gain ≤ 1, modulation ≥ 0 → amplitude ≤ gain × 1 × (1 + mod)
    expect(a.amplitude).toBeLessThanOrEqual(1.0 * (1 + a.modulation));
    //wrap-around : id hors bornes normalisé
    const wrap = champ.etatNeurone(TAILLE_CHAMP + 5, 10);
    expect(wrap.id).toBe(5);
  });

  it("couple les bandes du cortex aux 1000 régions (borné, mémorisant)", () => {
    const champ = new ChampCorticalGen3(42);
    champ.couplerBandes([0.5, 0.2, 0, 0, 0, 0, 0, 0]);
    const mod1 = champ.modulationRegionale();
    let somme = 0;
    for (const m of mod1) {
      expect(m).toBeGreaterThanOrEqual(0);
      somme += m;
    }
    expect(somme).toBeGreaterThan(0); // l'activité a bien couplé
    // Consolidation progressive (lissage 0.7/0.3) — un second couplage
    // nul fait décroître la modulation sans l'annuler brutalement.
    champ.couplerBandes(new Array(8).fill(0));
    const mod2 = champ.modulationRegionale();
    for (let r = 0; r < REGIONS; r++) {
      expect(mod2[r]).toBeLessThan(mod1[r] + 1e-12);
    }
  });

  it("échantillonnage stratifié : erreur réelle ≈ 1.96·σ/√n", () => {
    const champ = new ChampCorticalGen3(42);
    champ.couplerBandes([0.1, 0, 0, 0, 0, 0, 0, 0]);
    const n = 4096;
    const stats = champ.echantillonner(5, n);
    expect(stats.echantillons).toBe(n);
    expect(stats.taille).toBe(TAILLE_CHAMP);
    expect(stats.amplitudeMoyenne).toBeGreaterThan(0);
    expect(stats.amplitudeMoyenne).toBeLessThanOrEqual(1 + 0.5);
    expect(stats.amplitudeEcartType).toBeGreaterThanOrEqual(0);
    const erreurAttendue = (1.96 * stats.amplitudeEcartType) / Math.sqrt(n);
    expect(stats.erreurEchantillon).toBeCloseTo(erreurAttendue, 12);
    expect(stats.fractionActive).toBeGreaterThanOrEqual(0);
    expect(stats.fractionActive).toBeLessThanOrEqual(1);
  });

  it("consolidation d'apprentissage : graine évolutive et reproductible", () => {
    const a = new ChampCorticalGen3(42);
    const b = new ChampCorticalGen3(42);
    a.consoliderApprentissage(5, 200);
    b.consoliderApprentissage(5, 200);
    expect(a.seedEntrainement).toBe(b.seedEntrainement);
    expect(a.seedEntrainement).not.toBe(42); // la graine a évolué
    // Deux chemins d'apprentissage différents → graines différentes.
    const c = new ChampCorticalGen3(42);
    c.consoliderApprentissage(6, 200);
    expect(c.seedEntrainement).not.toBe(a.seedEntrainement);
    // L'état d'onde d'un même neurone change avec la nouvelle graine
    // (les 1e9 neurones « apprennent » par leur paramétrage).
    const avant = a.etatNeurone(987654321, 3);
    const apres = c.etatNeurone(987654321, 3);
    expect(apres.frequence).not.toBe(avant.frequence);
  });

  it("import/export de la modulation régionale avec validation", () => {
    const champ = new ChampCorticalGen3(7);
    champ.couplerBandes([0.3, 0.3, 0, 0, 0, 0, 0, 0]);
    const copie = champ.modulationRegionale();
    const autre = new ChampCorticalGen3(7);
    expect(autre.importerModulation(copie)).toBe(true);
    expect(Array.from(autre.modulationRegionale())).toEqual(
      Array.from(copie),
    );
    expect(autre.importerModulation(new Float32Array(3))).toBe(false);
  });

  it("veille : micro-tonus déterministe borné", () => {
    const a = new ChampCorticalGen3(11);
    const b = new ChampCorticalGen3(11);
    a.veille(1);
    b.veille(1);
    expect(Array.from(a.modulationRegionale())).toEqual(
      Array.from(b.modulationRegionale()),
    );
    for (const m of a.modulationRegionale()) {
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThan(0.1);
    }
  });
});
