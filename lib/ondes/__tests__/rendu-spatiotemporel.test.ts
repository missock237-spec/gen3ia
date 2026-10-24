import { describe, expect, it } from "vitest";

import { MoteurRenduSpatiotemporel, MAX_TRAMES } from "@/lib/ondes/rendu-spatiotemporel";
import { BORNES_RPIA } from "@/lib/ondes/types-entrainement";

describe("rendu spatiotemporel par ondes (miroir node.amplitude 3D)", () => {
  it("déterminisme : même graine → même trame", () => {
    const a = new MoteurRenduSpatiotemporel(64, 48, 256, { graine: 7 });
    const b = new MoteurRenduSpatiotemporel(64, 48, 256, { graine: 7 });
    const cible = new Float32Array(256).fill(0.4);
    a.entrainerVers(cible, 3);
    b.entrainerVers(cible, 3);
    expect(Array.from(a.rendreTrame(1.0))).toEqual(Array.from(b.rendreTrame(1.0)));
  });

  it("trame RGBA : taille exacte, pixels bornés [0, 255], alpha opaque", () => {
    const moteur = new MoteurRenduSpatiotemporel(320, 180, 2048);
    const trame = moteur.rendreTrame(1.0);
    expect(trame).toHaveLength(320 * 180 * 4);
    for (let p = 0; p < trame.length; p += 4) {
      for (let c = 0; c < 3; c++) {
        expect(trame[p + c]).toBeGreaterThanOrEqual(0);
        expect(trame[p + c]).toBeLessThanOrEqual(255);
      }
      expect(trame[p + 3]).toBe(255);
    }
  });

  it("persistance de phase : deux trames voisines (30 fps) restent continues", () => {
    const moteur = new MoteurRenduSpatiotemporel(320, 180, 2048);
    const cible = new Float32Array(2048).fill(0.4);
    moteur.entrainerVers(cible, 3);
    const t1 = moteur.rendreTrame(1.0);
    const t2 = moteur.rendreTrame(1.033);
    let ecart = 0;
    for (let i = 0; i < t1.length; i += 4) ecart += Math.abs(t1[i] - t2[i]);
    ecart /= 320 * 180;
    expect(ecart).toBeLessThan(40);
  });

  it("guidage vidéo : amplitude et amortissement restent dans les bornes de la source", () => {
    const moteur = new MoteurRenduSpatiotemporel(64, 48, 128);
    const cible = new Float32Array(128).fill(-1); // interférence maximale
    moteur.entrainerVers(cible, 40);
    for (const noeud of moteur.etat()) {
      expect(noeud.amplitude).toBeGreaterThanOrEqual(BORNES_RPIA.amplitudeMin);
      expect(noeud.amplitude).toBeLessThanOrEqual(BORNES_RPIA.amplitudeMax);
      expect(noeud.amortissement).toBeGreaterThanOrEqual(BORNES_RPIA.amortissementVideoMin);
      expect(noeud.amortissement).toBeLessThanOrEqual(BORNES_RPIA.amortissementVideoMax);
      // Positions : dans l'image, jamais dehors.
      expect(noeud.posX).toBeGreaterThanOrEqual(0);
      expect(noeud.posX).toBeLessThan(64);
      expect(noeud.posY).toBeGreaterThanOrEqual(0);
      expect(noeud.posY).toBeLessThan(48);
    }
  });

  it("séquence : la boucle d'enregistrement produit le bon nombre de trames (garde MAX_TRAMES)", () => {
    const moteur = new MoteurRenduSpatiotemporel(64, 48, 256);
    const cible = new Float32Array(256).fill(0.5);
    const vue: number[] = [];
    const { trames, totalTrames } = moteur.genererSequence(0.5, 24, cible, 0.5, (i, total) =>
      vue.push(total),
    );
    expect(totalTrames).toBe(12); // 0.5 s × 24 fps
    expect(trames).toHaveLength(12);
    expect(vue).toHaveLength(12);
    expect(vue.every((t) => t === 12)).toBe(true);

    // Garde-fou : une demande absurde est plafonnée, jamais explosée.
    const garde = moteur.genererSequence(3600, 60, cible);
    expect(garde.totalTrames).toBe(MAX_TRAMES);
  });

  it("entrées invalides refusées (dimensions, nœuds, fps, cible)", () => {
    expect(() => new MoteurRenduSpatiotemporel(8, 48, 256)).toThrow(/Largeur invalide/);
    expect(() => new MoteurRenduSpatiotemporel(64, 2000, 256)).toThrow(/Hauteur invalide/);
    expect(() => new MoteurRenduSpatiotemporel(64, 48, 100000)).toThrow(/Nombre de nœuds invalide/);
    const moteur = new MoteurRenduSpatiotemporel(64, 48, 64);
    expect(() => moteur.genererSequence(1, 120, new Float32Array(64))).toThrow(/Fréquence d'images/);
    expect(() => moteur.pasGuidage(new Float32Array(32), 0.5, 0)).toThrow(/Cible incompatible/);
  });
});
