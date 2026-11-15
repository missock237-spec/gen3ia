import { describe, expect, it } from "vitest";

import { CONFIGS_EFFORT } from "@/lib/ondes/types";
import { MoteurCpu } from "@/lib/ondes/champ";
import { CarteInverse, signatureMot } from "@/lib/ondes/encodeur";
import { DecodeurResonance } from "@/lib/ondes/decodeur";

describe("moteur CPU — physique d'ondes (miroir du shader WGSL)", () => {
  it("cycle de vie d'une onde : propagation puis dissipation par l'amortissement", async () => {
    const moteur = new MoteurCpu(CONFIGS_EFFORT.faible);
    moteur.injecter([{ x: 64, y: 64, amplitude: 8, frequence: 0.1, phase: 0, rayon: 2.5 }]);
    moteur.avancer();
    const initiale = await moteur.lire();
    // Le choc d'onde crée immédiatement un pic de résonance intense.
    expect(initiale.pics.length).toBeGreaterThan(0);
    expect(initiale.pics[0].amplitude).toBeGreaterThan(5);

    // L'onde se répand : l'énergie MOYENNE du champ monte (transitoire).
    for (let i = 0; i < 99; i++) moteur.avancer();
    const propagee = await moteur.lire();
    expect(propagee.energie).toBeGreaterThan(initiale.energie);

    // Puis l'amortissement l'emporte : le champ retourne au silence.
    for (let i = 0; i < 500; i++) moteur.avancer();
    const dissipee = await moteur.lire();
    expect(dissipee.energie).toBeLessThan(initiale.energie);
    expect(dissipee.energie).toBeLessThan(0.002);
    moteur.detruire();
  });

  it("le paramètre d'ordre r reste dans [0, 1] et les pas s'accumulent", async () => {
    const moteur = new MoteurCpu(CONFIGS_EFFORT.faible);
    for (let i = 0; i < 20; i++) {
      moteur.injecter([{ x: 30 + i, y: 90, amplitude: 1.5, frequence: 0.08, phase: i, rayon: 2 }]);
      moteur.avancer();
      const lecture = await moteur.lire();
      expect(lecture.ordreR).toBeGreaterThanOrEqual(0);
      expect(lecture.ordreR).toBeLessThanOrEqual(1);
      expect(lecture.energie).toBeGreaterThanOrEqual(0);
    }
    expect(moteur.pasTotaux).toBe(20);
    moteur.detruire();
  });

  it("les bords du champ absorbent l'onde (pas de réflexion parasite)", async () => {
    const moteur = new MoteurCpu(CONFIGS_EFFORT.faible);
    moteur.injecter([{ x: 2, y: 2, amplitude: 4, frequence: 0.1, phase: 0, rayon: 2 }]);
    moteur.avancer();
    moteur.avancer();
    const lecture = await moteur.lire();
    for (const pic of lecture.pics) {
      // Aucun pic ne persiste sur la bordure (amplitude forcée à 0).
      expect(pic.x).toBeGreaterThan(1);
      expect(pic.y).toBeGreaterThan(1);
      expect(pic.x).toBeLessThan(126);
      expect(pic.y).toBeLessThan(126);
    }
    moteur.detruire();
  });

  it("la reconfiguration change la grille ou ajuste les paramètres", () => {
    const moteur = new MoteurCpu(CONFIGS_EFFORT.faible);
    const freqAvant = moteur.frequences()[5000];
    moteur.reconfigurer({ ...CONFIGS_EFFORT.faible, amortissement: 0.95 });
    expect(moteur.config().amortissement).toBe(0.95);
    expect(moteur.frequences()[5000]).toBe(freqAvant); // évolution conservée
    moteur.reconfigurer(CONFIGS_EFFORT.moyen);
    expect(moteur.largeur).toBe(192);
    expect(moteur.frequences().length).toBe(192 * 192);
    moteur.detruire();
  });
});

describe("décodeur de résonance — écriture progressive", () => {
  const dim = 128;

  const fabrique = () => {
    const carte = new CarteInverse();
    carte.enregistrer("aurore", dim);
    carte.enregistrer("vague", dim);
    const decodeur = new DecodeurResonance(carte, dim);
    return { carte, decodeur };
  };

  const picsPour = (mot: string) => {
    const sig = signatureMot(mot, dim);
    return [{ x: sig.x, y: sig.y, amplitude: 2.5, phase: sig.phase }];
  };

  it("un pic doit se stabiliser avant de parler (stabilité ≥ 3)", () => {
    const { decodeur } = fabrique();
    const pics = picsPour("aurore");
    expect(decodeur.observer(pics, 0)).toBe(null);
    expect(decodeur.observer(pics, 100)).toBe(null);
    expect(decodeur.observer(pics, 200)).toBe("aurore"); // stabilisé → parle
  });

  it("écriture progressive : jamais deux mots dans le même instant", () => {
    const { decodeur } = fabrique();
    const pics = [...picsPour("aurore"), ...picsPour("vague")];
    expect(decodeur.observer(pics, 0)).toBe(null);
    expect(decodeur.observer(pics, 100)).toBe(null);
    const premier = decodeur.observer(pics, 200);
    expect(premier).not.toBe(null);
    // 30 ms plus tard : intervalle minimum non respecté → silence.
    expect(decodeur.observer(pics, 230)).toBe(null);
    // 200 ms plus tard : le second mot peut émerger.
    const second = decodeur.observer(pics, 400);
    expect(second).not.toBe(null);
    expect(second).not.toBe(premier);
  });

  it("anti-répétition : le même mot ne revient pas en boucle", () => {
    const { decodeur } = fabrique();
    const pics = picsPour("aurore");
    decodeur.observer(pics, 0);
    decodeur.observer(pics, 100);
    expect(decodeur.observer(pics, 200)).toBe("aurore");
    // Le pic continue de résonner → le mot est consommé, pas répété.
    expect(decodeur.observer(pics, 400)).toBe(null);
    expect(decodeur.observer(pics, 600)).toBe(null);
  });

  it("un pic sans mot enregistré reste muet", () => {
    const carte = new CarteInverse();
    const decodeur = new DecodeurResonance(carte, dim);
    const pics = picsPour("aurore"); // jamais enregistré dans la carte
    decodeur.observer(pics, 0);
    decodeur.observer(pics, 100);
    expect(decodeur.observer(pics, 200)).toBe(null);
  });

  it("la redimension purge les pistes (changement d'effort)", () => {
    const { decodeur } = fabrique();
    decodeur.observer(picsPour("aurore"), 0);
    decodeur.redimensionner(256);
    expect(decodeur.nbPistes).toBe(0);
  });
});
