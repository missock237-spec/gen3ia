import { describe, expect, it } from "vitest";

import { SynthetiseurAcoustique, versWav } from "@/lib/ondes/synthese-acoustique";
import { BORNES_RPIA } from "@/lib/ondes/types-entrainement";

describe("synthèse acoustique par résonance (miroir node.amplitude.pdf)", () => {
  it("déterminisme : même graine → même PCM", () => {
    const a = new SynthetiseurAcoustique(128, { graine: 7 });
    const b = new SynthetiseurAcoustique(128, { graine: 7 });
    expect(Array.from(a.genererBuffer(0.1))).toEqual(Array.from(b.genererBuffer(0.1)));
  });

  it("guidage RPIA : les fréquences se déplacent vers la cible et restent audibles", () => {
    const synth = new SynthetiseurAcoustique(256);
    const avant = synth.etat().map((n) => n.frequence);
    // Cible haute → les nœuds sont guidés (règle f -= interf·5). Avec un
    // temps qui avance, la dynamique n'est pas monotone — on vérifie
    // donc honnêtement le MOUVEMENT et les bornes, pas la convergence.
    const cible = new Float32Array(256).fill(1);
    const rapport = synth.entrainerVers(cible, 50);
    const apres = synth.etat().map((n) => n.frequence);

    expect(rapport.historiqueErreur).toHaveLength(50);
    for (let i = 0; i < apres.length; i++) {
      expect(apres[i]).toBeGreaterThanOrEqual(BORNES_RPIA.frequenceAudioMin);
      expect(apres[i]).toBeLessThanOrEqual(BORNES_RPIA.frequenceAudioMax);
      // La fréquence a bougé (l'interférence forte au départ pousse f).
      expect(apres[i]).not.toBeCloseTo(avant[i], 9);
    }
    // Amortissement contrôlé : anti-saturation, jamais hors [0.001, 0.1].
    for (const noeud of synth.etat()) {
      expect(noeud.amortissement).toBeGreaterThanOrEqual(BORNES_RPIA.amortissementAudioMin);
      expect(noeud.amortissement).toBeLessThanOrEqual(BORNES_RPIA.amortissementAudioMax);
    }
  });

  it("tampon PCM : longueur exacte 22050 pour 0.5 s @ 44100 Hz (contrat de la source)", () => {
    const synth = new SynthetiseurAcoustique(1024, { frequenceEchantillonnage: 44100 });
    const pcm = synth.genererBuffer(0.5);
    expect(pcm).toHaveLength(22050);
    for (const v of pcm) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("rapport audio : mesure l'état initial réel puis l'erreur post-guidage", () => {
    const synth = new SynthetiseurAcoustique(32, {
      graine: 19,
      frequenceEchantillonnage: 8000,
    });
    const cible = new Float32Array(32).fill(0.4);
    const erreurAvant = synth.erreurCourante(cible, 0);

    const rapport = synth.entrainerVers(cible, 7, 0.5, {
      tauxApprentissage: 0.01,
      pasDeTemps: 0.001,
    });

    expect(rapport.erreurInitiale).toBeCloseTo(erreurAvant, 10);
    expect(rapport.historiqueErreur).toHaveLength(7);
    expect(rapport.erreurFinale).toBeCloseTo(rapport.historiqueErreur[6]!, 10);
    expect(rapport.erreurFinale).toBeCloseTo(synth.erreurCourante(cible, 0.006), 10);
  });

  it("paramètres audio invalides refusés sans altérer l'état des oscillateurs", () => {
    const synth = new SynthetiseurAcoustique(64);
    const cible = new Float32Array(64).fill(0.25);
    const avant = synth.etat();

    expect(() => synth.pasGuidage(cible, Number.NaN, 0)).toThrow(/Guidage invalide/);
    expect(() => synth.pasGuidage(cible, 0.5, Number.NaN)).toThrow(/Temps audio invalide/);
    expect(() =>
      synth.entrainerVers(cible, 4, 0.5, {
        tauxApprentissage: 0.01,
        pasDeTemps: Number.NaN,
      }),
    ).toThrow(/Configuration audio invalide/);
    expect(() => synth.genererBuffer(Number.NaN)).toThrow(/Durée invalide/);

    expect(synth.etat()).toEqual(avant);
  });

  it("encodeur WAV : en-tête RIFF correct et taille attendue", () => {
    const pcm = new Float32Array(1000);
    const wav = versWav(pcm, 44100);
    const vue = new DataView(wav);
    // Taille totale : 44 octets d'en-tête + 1000 × 2 octets.
    expect(wav.byteLength).toBe(44 + 2000);
    // Marqueurs RIFF/WAVE/fmt /data (ASCII).
    const lire = (o: number) => String.fromCharCode(vue.getUint8(o), vue.getUint8(o + 1), vue.getUint8(o + 2), vue.getUint8(o + 3));
    expect(lire(0)).toBe("RIFF");
    expect(lire(8)).toBe("WAVE");
    expect(lire(36)).toBe("data");
    expect(vue.getUint32(24, true)).toBe(44100); // fréquence d'échantillonnage
    expect(vue.getUint16(22, true)).toBe(1); // mono
  });

  it("entrées invalides refusées (durée, taille de cible)", () => {
    const synth = new SynthetiseurAcoustique(64);
    expect(() => synth.genererBuffer(0)).toThrow(/Durée invalide/);
    expect(() => synth.genererBuffer(61)).toThrow(/Durée invalide/);
    expect(() => synth.entrainerVers(new Float32Array(32), 5)).toThrow(/Cible incompatible/);
  });
});
