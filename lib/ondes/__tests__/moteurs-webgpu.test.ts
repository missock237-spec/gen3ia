import { describe, expect, it } from "vitest";

import {
  MoteurAudioCpu,
  MoteurVideoCpu,
  BLOC_ECHANTILLONS,
  GUIDAGE_AUDIO_DEFAUT,
  GUIDAGE_VIDEO_DEFAUT,
  creerMoteurAudioRPIA,
  creerMoteurVideoRPIA,
  noeuds3DVersTampon,
  tamponVersNoeuds3D,
  noeudsAcoustiquesVersTampon,
  tamponVersNoeudsAcoustiques,
} from "../moteurs-webgpu";
import { MoteurRenduSpatiotemporel, rasteriserTrame } from "../rendu-spatiotemporel";
import { SynthetiseurAcoustique } from "../synthese-acoustique";
import { encoderTexteEnOndeCible } from "../conditionneur";

/**
 * MOTEURS WEBGPU VIDÉO + AUDIO (portage Gen3VideoEngine / Gen3AudioEngine)
 * — les tests exécutent les MIROIRS CPU (specification exécutable) : même
 * contrat, même physique, WebGPU indisponible dans l'environnement de test.
 */

describe("MoteurVideoCpu — portage Gen3VideoEngine", () => {
  it("les défauts sont ceux de la source (1280×720, 8192 nœuds)", () => {
    const moteur = new MoteurVideoCpu();
    expect(moteur.largeur).toBe(1280);
    expect(moteur.hauteur).toBe(720);
    expect(moteur.nbNoeuds).toBe(8192);
    expect(moteur.type).toBe("cpu");
  });

  it("rend une trame RGBA complète (largeur×hauteur×4, alpha 255)", async () => {
    const moteur = new MoteurVideoCpu(64, 48, 128);
    const cible = encoderTexteEnOndeCible("une cascade tropicale", moteur.nbNoeuds);
    const { trame, erreur } = await moteur.rendreTrame(0.5, cible);
    expect(trame.length).toBe(64 * 48 * 4);
    // Alpha opaque sur TOUS les pixels (format RGBA prêt encodeur).
    for (let p = 0; p < trame.length; p += 4) {
      expect(trame[p + 3]).toBe(255);
    }
    expect(erreur).toEqual(expect.any(Number));
    expect(Number.isFinite(erreur)).toBe(true);
    expect(erreur).toBeGreaterThanOrEqual(0);
  });

  it("est déterministe : même graine + même cible → même trame", async () => {
    const a = new MoteurVideoCpu(48, 48, 100, 42);
    const b = new MoteurVideoCpu(48, 48, 100, 42);
    const cible = encoderTexteEnOndeCible("ville futuriste néon", a.nbNoeuds);
    const ra = await a.rendreTrame(1.25, cible);
    const rb = await b.rendreTrame(1.25, cible);
    expect(Array.from(ra.trame)).toEqual(Array.from(rb.trame));
    expect(ra.erreur).toBeCloseTo(rb.erreur, 10);
  });

  it("le guidage déplace réellement le champ (deux cibles → deux rendus)", async () => {
    const moteur = new MoteurVideoCpu(48, 48, 100);
    const cibleA = encoderTexteEnOndeCible("un chien doré au parc", moteur.nbNoeuds);
    const cibleB = encoderTexteEnOndeCible("un désert martien rouge", moteur.nbNoeuds);
    const ra = await moteur.rendreTrame(1, cibleA);
    const rb = await moteur.rendreTrame(1, cibleB);
    expect(Array.from(ra.trame)).not.toEqual(Array.from(rb.trame));
  });

  it("le guidage par défaut est celui de la source (0.8)", async () => {
    expect(GUIDAGE_VIDEO_DEFAUT).toBe(0.8);
  });

  it("rejette une cible de mauvaise taille (garde du portage)", async () => {
    const moteur = new MoteurVideoCpu(48, 48, 100);
    await expect(moteur.rendreTrame(0, new Float32Array(99))).rejects.toThrow(/Cible incompatible/);
  });
});

describe("MoteurAudioCpu — portage Gen3AudioEngine", () => {
  it("les défauts sont ceux de la source (2048 nœuds, 44100 Hz)", () => {
    const moteur = new MoteurAudioCpu();
    expect(moteur.nbNoeuds).toBe(2048);
    expect(moteur.frequenceEchantillonnage).toBe(44100);
    expect(moteur.type).toBe("cpu");
  });

  it("génère un PCM réel borné [-1, 1] avec le blockStep de la source (1024)", async () => {
    const moteur = new MoteurAudioCpu(64, 8000);
    const cible = encoderTexteEnOndeCible("voix off chaleureuse", moteur.nbNoeuds);
    const { pcm, erreur, blocs } = await moteur.genererBuffer(0.5, cible);
    expect(pcm.length).toBe(0.5 * 8000);
    for (const e of pcm) {
      expect(e).toBeGreaterThanOrEqual(-1);
      expect(e).toBeLessThanOrEqual(1);
    }
    expect(erreur).toEqual(expect.any(Number));
    expect(Number.isFinite(erreur)).toBe(true);
    expect(blocs).toBe(Math.ceil(0.5 * 8000 / BLOC_ECHANTILLONS));
  });

  it("le dernier bloc partiel est traité sans débordement", async () => {
    const moteur = new MoteurAudioCpu(32, 8000);
    const cible = encoderTexteEnOndeCible("pluie sur un toit", moteur.nbNoeuds);
    // 1500 échantillons = 1 bloc complet (1024) + 1 bloc partiel (476).
    const { pcm, blocs } = await moteur.genererBuffer(1500 / 8000, cible);
    expect(pcm.length).toBe(1500);
    expect(blocs).toBe(2);
  });

  it("est déterministe : même graine + même cible → même PCM", async () => {
    const a = new MoteurAudioCpu(64, 8000, 42);
    const b = new MoteurAudioCpu(64, 8000, 42);
    const cible = encoderTexteEnOndeCible("ambiance de forêt", a.nbNoeuds);
    const ra = await a.genererBuffer(0.2, cible);
    const rb = await b.genererBuffer(0.2, cible);
    expect(Array.from(ra.pcm)).toEqual(Array.from(rb.pcm));
  });

  it("le guidage par défaut est celui de la source (0.7)", async () => {
    expect(GUIDAGE_AUDIO_DEFAUT).toBe(0.7);
  });

  it("rejette une durée invalide (garde du miroir)", async () => {
    const moteur = new MoteurAudioCpu(32, 8000);
    const cible = encoderTexteEnOndeCible("test", moteur.nbNoeuds);
    await expect(moteur.genererBuffer(0, cible)).rejects.toThrow(/Durée invalide/);
    await expect(moteur.genererBuffer(61, cible)).rejects.toThrow(/Durée invalide/);
  });

  it("rejette une cible de mauvaise taille", async () => {
    const moteur = new MoteurAudioCpu(32, 8000);
    await expect(moteur.genererBuffer(0.1, new Float32Array(7))).rejects.toThrow(/Cible incompatible/);
  });
});

describe("Parité avec les miroirs existants (fonctions pures partagées)", () => {
  it("rasteriserTrame reproduit EXACTMENT MoteurRenduSpatiotemporel.rendreTrame", () => {
    const miroir = new MoteurRenduSpatiotemporel(64, 48, 100, { graine: 42 });
    const trameMiroir = miroir.rendreTrame(2.5);
    const tramePur = rasteriserTrame(miroir.etat(), 64, 48, 2.5);
    expect(Array.from(tramePur)).toEqual(Array.from(trameMiroir));
  });

  it("mixerIntervalle reconstitue EXACTMENT genererBuffer (cohérence blocs)", () => {
    const synth = new SynthetiseurAcoustique(64, { graine: 42, frequenceEchantillonnage: 8000 });
    const complet = synth.genererBuffer(0.25);
    const moitie = Math.floor(complet.length / 2);
    const blocs = [
      ...synth.mixerIntervalle(0, moitie),
      ...synth.mixerIntervalle(moitie, complet.length - moitie),
    ];
    expect(Array.from(blocs)).toEqual(Array.from(complet));
  });

  it("les sérialisations packées font des aller-retours f32 (précision GPU)", () => {
    // Les tampons GPU sont f32 : le pack arrondit les f64 JS — mêmes
    // valeurs à la précision f32 près (même contrat que l'export de poids
    // de l'entraîneur RPIA).
    const video = new MoteurRenduSpatiotemporel(32, 32, 50, { graine: 7 });
    const packVideo = noeuds3DVersTampon(video.etat());
    expect(packVideo.length).toBe(50 * 6);
    const retourVideo = tamponVersNoeuds3D(packVideo);
    expect(retourVideo.length).toBe(50);
    for (let i = 0; i < 50; i++) {
      expect(retourVideo[i].amplitude).toBeCloseTo(video.etat()[i].amplitude, 5);
      expect(retourVideo[i].posX).toBeCloseTo(video.etat()[i].posX, 3);
    }

    const audio = new SynthetiseurAcoustique(80, { graine: 7, frequenceEchantillonnage: 8000 });
    const packAudio = noeudsAcoustiquesVersTampon(audio.etat());
    expect(packAudio.length).toBe(80 * 4);
    const retourAudio = tamponVersNoeudsAcoustiques(packAudio);
    expect(retourAudio.length).toBe(80);
    for (let i = 0; i < 80; i++) {
      expect(retourAudio[i].frequence).toBeCloseTo(audio.etat()[i].frequence, 2);
    }
  });
});

describe("Fabriques — repli CPU propre sans WebGPU", () => {
  it("creerMoteurVideoRPIA retombe sur le miroir CPU avec raison affichable", async () => {
    const { moteur, type, raison } = await creerMoteurVideoRPIA({
      largeur: 64,
      hauteur: 48,
      nbNoeuds: 100,
    });
    expect(moteur.type).toBe("cpu");
    expect(type).toBe("cpu");
    expect(raison).toBeTruthy();
    expect(moteur.largeur).toBe(64);
    await moteur.detruire();
  });

  it("creerMoteurAudioRPIA retombe sur le miroir CPU avec raison affichable", async () => {
    const { moteur, type, raison } = await creerMoteurAudioRPIA({
      nbNoeuds: 64,
      frequenceEchantillonnage: 8000,
    });
    expect(moteur.type).toBe("cpu");
    expect(type).toBe("cpu");
    expect(raison).toBeTruthy();
    await moteur.detruire();
  });
});
