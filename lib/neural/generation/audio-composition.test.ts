import { describe, expect, it } from "vitest";

import type { NeuralSnapshot } from "./snapshot";
import { analyserScene } from "./scene-spec";
import { genererAudioScene, sceneSonore } from "./audio-composition";

/**
 * MOTEUR AUDIO SCÉNIQUE v2 — verrous :
 *  1. WAV VALIDE : en-tête RIFF correct, PCM 16 bits mono, durée exacte ;
 *  2. COUCHES SÉMANTIQUES : pluie → « pluie », vagues → « vagues »,
 *     forêt → « oiseaux », ville → « foule », orage → « orage » ;
 *  3. MUSIQUE STRUCTURÉE : tempo et mode dérivés de l'ambiance
 *     (joyeux → majeur 120 bpm, mélancolique → mineur 76 bpm) ;
 *  4. DÉTERMINISME bit-à-bit ;
 *  5. bornes de durée et de fréquence d'échantillonnage respectées ;
 *  6. sceneSonore : critère honnête de bascule v2 / repli v1.
 */

function snapshotFactice(seed = 4242): NeuralSnapshot {
  return {
    seed,
    nbNeurones: 120,
    nbSynapses: 480,
    poidsMoyen: 0.5,
    histogramme: Array.from({ length: 10 }, () => 0.1),
    echantillonSynapses: Array.from({ length: 80 }, (_, i) => [i, i + 1, 0.3 + (i % 5) / 10] as [number, number, number]),
    energies: [],
    neuronTokens: [],
    tokens: ["pluie"],
  };
}

/** Vérifie l'en-tête RIFF/WAVE (PCM 16 bits mono). */
function attendreEnTeteWav(wav: Buffer, sampleRate: number): void {
  expect(wav.slice(0, 4).toString("ascii")).toBe("RIFF");
  expect(wav.slice(8, 12).toString("ascii")).toBe("WAVE");
  expect(wav.slice(12, 16).toString("ascii")).toBe("fmt ");
  expect(wav.readUInt16LE(20)).toBe(1); // PCM
  expect(wav.readUInt16LE(22)).toBe(1); // mono
  expect(wav.readUInt32LE(24)).toBe(sampleRate);
  expect(wav.readUInt16LE(34)).toBe(16); // bits
  expect(wav.slice(36, 40).toString("ascii")).toBe("data");
}

describe("genererAudioScene — fichier WAV valide", () => {
  it("« pluie sur les vitres dans la forêt » → WAV 3 s à 22 050 Hz avec couches sémantiques", () => {
    const scene = analyserScene("pluie sur les vitres dans la forêt");
    const rendu = genererAudioScene("pluie sur les vitres dans la forêt", 3, 22050, snapshotFactice(), scene);
    attendreEnTeteWav(rendu.wav, 22050);
    expect(rendu.dureeSecondes).toBe(3);
    expect(rendu.wav.length).toBe(44 + 3 * 22050 * 2);
    expect(rendu.meta.couches).toContain("pluie");
    expect(rendu.meta.couches).toContain("oiseaux");
  });

  it("« vagues sur la plage » → couche vagues ; « la foule du marché en ville » → foule", () => {
    const mer = genererAudioScene("vagues sur la plage", 2, 22050, snapshotFactice(), analyserScene("vagues sur la plage"));
    expect(mer.meta.couches).toContain("vagues");
    const ville = genererAudioScene("la foule du marché en ville", 2, 22050, snapshotFactice(), analyserScene("la foule du marché en ville"));
    expect(ville.meta.couches).toContain("foule");
  });

  it("orage → couche tonnerre ; feu de cheminée → crépitements", () => {
    const orage = genererAudioScene("orage au loin dans la montagne", 4, 22050, snapshotFactice(), analyserScene("orage au loin dans la montagne"));
    expect(orage.meta.couches).toContain("orage");
    const feu = genererAudioScene("un feu de cheminée chaleureux", 3, 22050, snapshotFactice(), analyserScene("un feu de cheminée chaleureux"));
    expect(feu.meta.couches).toContain("feu");
  });

  it("cadre seul suffisant : « une montagne » → vent (ambiance de cadre)", () => {
    const scene = analyserScene("une montagne");
    const rendu = genererAudioScene("une montagne", 2, 22050, snapshotFactice(), scene);
    expect(rendu.meta.couches).toContain("vent");
  });
});

describe("genererAudioScene — musique structurée par l'ambiance", () => {
  it("joyeux → majeur à 120 bpm ; mélancolique → mineur à 76 bpm", () => {
    const joyeux = genererAudioScene("une fête joyeuse dans la prairie", 2, 22050, snapshotFactice(), analyserScene("une fête joyeuse dans la prairie"));
    expect(joyeux.meta.mode).toBe("majeur");
    expect(joyeux.meta.tempoBpm).toBe(120);
    const melancolique = genererAudioScene("un rivage mélancolique sous la pluie", 2, 22050, snapshotFactice(), analyserScene("un rivage mélancolique sous la pluie"));
    expect(melancolique.meta.mode).toBe("mineur");
    expect(melancolique.meta.tempoBpm).toBe(76);
  });

  it("l'ambiance par défaut est calme (72 bpm) quand rien n'est exprimé", () => {
    const rendu = genererAudioScene("un ruisseau dans la forêt", 2, 22050, snapshotFactice(), analyserScene("un ruisseau dans la forêt"));
    expect(rendu.meta.tempoBpm).toBe(72);
  });
});

describe("genererAudioScene — déterminisme et bornes", () => {
  it("même (prompt, snapshot, scène) → WAV bit-à-bit identique", () => {
    const scene = analyserScene("pluie sur les vitres");
    const a = genererAudioScene("pluie sur les vitres", 2, 22050, snapshotFactice(99), scene);
    const b = genererAudioScene("pluie sur les vitres", 2, 22050, snapshotFactice(99), scene);
    expect(a.wav.equals(b.wav)).toBe(true);
  });

  it("cerveaux différents → fichiers différents (synapses impliquées)", () => {
    const scene = analyserScene("vagues sur la plage");
    const a = genererAudioScene("vagues sur la plage", 2, 22050, snapshotFactice(1), scene);
    const b = genererAudioScene("vagues sur la plage", 2, 22050, snapshotFactice(2), scene);
    expect(a.wav.equals(b.wav)).toBe(false);
  });

  it("durée plafonnée à 30 s, fréquence bornée 8 000–48 000 Hz", () => {
    const rendu = genererAudioScene("pluie", 120, 96_000, snapshotFactice(), analyserScene("pluie"));
    expect(rendu.dureeSecondes).toBe(30);
    expect(rendu.sampleRate).toBe(48_000);
  });
});

describe("sceneSonore — critère honnête de bascule v2", () => {
  it("sons nommés, météo ou cadre → sonore ; prompt hors vocabulaire → non", () => {
    expect(sceneSonore(analyserScene("pluie sur les vitres"))).toBe(true);
    expect(sceneSonore(analyserScene("une tempête en mer"))).toBe(true);
    expect(sceneSonore(analyserScene("une montagne"))).toBe(true);
    expect(sceneSonore(analyserScene("xyzzy florb quux"))).toBe(false);
  });
});
