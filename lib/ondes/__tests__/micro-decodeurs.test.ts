import { describe, expect, it } from "vitest";

import {
  DecodeurAudioPhase,
  DecodeurImageWavelet,
  DecodeurVideoDerive,
  noeudsActifsDuTenseur,
} from "../micro-decodeurs";
import { creerTenseur, texteVersTenseur } from "../manifold";
import { SHADER_DECODE_AUDIO_PHASE, SHADER_DECODE_IMAGE_WAVELET, SHADER_DECODE_VIDEO_DERIVE } from "../shaders-manifold";

/**
 * MICRO-DÉCODEURS MULTIMODAUX (Phase 2) — les tests exécutent les
 * MIROIRS CPU des shaders WebGPU (spécification exécutable) : même
 * contrat, même physique — WebGPU est indisponible en test.
 */

describe("DecodeurImageWavelet — miroir SHADER_DECODE_IMAGE_WAVELET", () => {
  it("rend une image RGBA complète, alpha opaque", () => {
    const d = new DecodeurImageWavelet(48, 48);
    const t = texteVersTenseur("une cascade tropicale", 64);
    const r = d.rendre(t);
    expect(r.pixels.length).toBe(48 * 48 * 4);
    for (let p = 3; p < r.pixels.length; p += 4) {
      expect(r.pixels[p]).toBe(255);
    }
  });

  it("est déterministe : même tenseur → mêmes pixels", () => {
    const t = texteVersTenseur("ville futuriste néon", 64);
    const a = new DecodeurImageWavelet(32, 32).rendre(t).pixels;
    const b = new DecodeurImageWavelet(32, 32).rendre(t).pixels;
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("deux tenseurs différents → deux images différentes", () => {
    const a = new DecodeurImageWavelet(32, 32).rendre(texteVersTenseur("un chien doré", 64)).pixels;
    const b = new DecodeurImageWavelet(32, 32).rendre(texteVersTenseur("un désert martien", 64)).pixels;
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("applique l'activation sparse et en rend compte", () => {
    const d = new DecodeurImageWavelet(32, 32);
    const t = texteVersTenseur("un mot", 256);
    const r = d.rendre(t);
    expect(r.nbHarmoniquesActives + r.nbHarmoniquesSautees).toBe(256);
    expect(r.nbHarmoniquesActives).toBe(noeudsActifsDuTenseur(t).length);
    expect(r.nbHarmoniquesSautees).toBeGreaterThan(0); // texte court → tenseur creux
  });

  it("le gain de lumière change réellement le rendu (éclairage procédural)", () => {
    const t = texteVersTenseur("un lever de soleil brumeux", 64);
    const sansEclairage = new DecodeurImageWavelet(32, 32, { gainLumiere: 0 }).rendre(t).pixels;
    const avecEclairage = new DecodeurImageWavelet(32, 32, { gainLumiere: 0.45 }).rendre(t).pixels;
    expect(Array.from(sansEclairage)).not.toEqual(Array.from(avecEclairage));
  });

  it("valide ses dimensions", () => {
    expect(() => new DecodeurImageWavelet(4, 32)).toThrow(/Largeur/);
    expect(() => new DecodeurImageWavelet(32, 4096)).toThrow(/Hauteur/);
  });
});

describe("DecodeurAudioPhase — miroir SHADER_DECODE_AUDIO_PHASE", () => {
  it("produit un PCM borné [-1, 1], non muet, déterministe", () => {
    const d = new DecodeurAudioPhase();
    const t = texteVersTenseur("bonjour le monde", 64);
    const a = d.synthetiser(t, 4096);
    const b = d.synthetiser(t, 4096);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(4096);
    let max = 0;
    for (let s = 0; s < a.length; s++) {
      expect(Math.abs(a[s])).toBeLessThanOrEqual(1);
      max = Math.max(max, Math.abs(a[s]));
    }
    expect(max).toBeGreaterThan(0.01);
  });

  it("un tenseur muet produit le silence (sparse : rien ne chante)", () => {
    const d = new DecodeurAudioPhase();
    const t = creerTenseur(
      Array.from({ length: 32 }, () => 0),
      Array.from({ length: 32 }, () => 0),
      0.08,
    );
    const pcm = d.synthetiser(t, 1024);
    for (let s = 0; s < pcm.length; s++) expect(pcm[s]).toBe(0);
  });

  it("la fondamentale du tenseur transpose la hauteur (F0 audible)", () => {
    const grave = new DecodeurAudioPhase().frequenceOscillateur(
      creerTenseur([1], [0], 0.04),
      0,
    );
    const aigu = new DecodeurAudioPhase().frequenceOscillateur(
      creerTenseur([1], [0], 0.16),
      0,
    );
    expect(aigu).toBeCloseTo(grave * 4, 6); // 0.16 / 0.04 = ×4
    expect(grave).toBeGreaterThan(0);
    expect(aigu).toBeLessThan(22050); // Nyquist
  });

  it("encode un WAV 16 bits RIFF valide", () => {
    const d = new DecodeurAudioPhase();
    const t = texteVersTenseur("voix grave", 32);
    const pcm = d.synthetiser(t, 2048);
    const wav = d.encoderWav(pcm);
    expect(wav.byteLength).toBe(44 + 2048 * 2);
    const vue = new DataView(wav);
    const texte = (o: number, n: number) =>
      String.fromCharCode(...Array.from(new Uint8Array(wav, o, n)));
    expect(texte(0, 4)).toBe("RIFF");
    expect(texte(8, 4)).toBe("WAVE");
    expect(vue.getUint32(24, true)).toBe(44100); // fréquence
    expect(vue.getUint16(34, true)).toBe(16); // bits/échantillon
  });

  it("valide ses bornes", () => {
    const d = new DecodeurAudioPhase();
    const t = texteVersTenseur("test", 32);
    expect(() => d.synthetiser(t, 0)).toThrow(/invalide/);
    expect(() => d.synthetiser(t, 44100 * 61)).toThrow(/trop longue/);
  });
});

describe("DecodeurVideoDerive — miroir SHADER_DECODE_VIDEO_DERIVE", () => {
  const W = 32;
  const H = 32;
  const trameNeutre = () => {
    const px = new Uint8ClampedArray(W * H * 4);
    for (let p = 0; p < px.length; p += 4) {
      px[p] = 128;
      px[p + 1] = 128;
      px[p + 2] = 128;
      px[p + 3] = 255;
    }
    return px;
  };

  it("propage la trame avec alpha opaque et métriques de dérive", () => {
    const d = new DecodeurVideoDerive(W, H);
    const t = texteVersTenseur("une vague qui monte", 64);
    const r = d.trameSuivante(trameNeutre(), t);
    expect(r.trame.length).toBe(W * H * 4);
    for (let p = 3; p < r.trame.length; p += 4) expect(r.trame[p]).toBe(255);
    expect(r.deriveMaximale).toBeGreaterThan(0);
    expect(r.deriveMoyenne).toBeGreaterThanOrEqual(0);
    expect(r.deriveMoyenne).toBeLessThanOrEqual(r.deriveMaximale);
  });

  it("est déterministe", () => {
    const d = new DecodeurVideoDerive(W, H);
    const t = texteVersTenseur("cascade", 64);
    const a = d.trameSuivante(trameNeutre(), t).trame;
    const b = d.trameSuivante(trameNeutre(), t).trame;
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("un tenseur muet laisse la trame inchangée (advection nulle + résurrection nulle)", () => {
    const d = new DecodeurVideoDerive(W, H);
    const muet = creerTenseur(
      Array.from({ length: 16 }, () => 0),
      Array.from({ length: 16 }, () => 0),
      0.08,
    );
    const r = d.trameSuivante(trameNeutre(), muet);
    expect(Array.from(r.trame)).toEqual(Array.from(trameNeutre()));
    expect(r.deriveMaximale).toBe(0);
  });

  it("la phase oriente la dérive : phase 0 → déplacement vers +x", () => {
    const d = new DecodeurVideoDerive(W, H);
    // Tenseur uniforme : amplitude max, phase 0 → (dx, dy) = (+8, 0).
    const t = creerTenseur(
      Array.from({ length: 16 }, () => 1),
      Array.from({ length: 16 }, () => 0),
      0.08,
    );
    const r = d.trameSuivante(trameNeutre(), t);
    expect(r.deriveMoyenne).toBeGreaterThan(7); // ~8 px partout
    // Résurrection : amplitude 1 → +0.15 sur chaque canal (128 → ~160).
    const centre = ((H / 2) * W + W / 2) * 4;
    expect(r.trame[centre]).toBeGreaterThan(140);
  });

  it("refuse une trame incohérente", () => {
    const d = new DecodeurVideoDerive(W, H);
    const t = texteVersTenseur("test", 16);
    expect(() => d.trameSuivante(new Uint8ClampedArray(10), t)).toThrow(/incohérente/);
  });
});

describe("Shaders WGSL (contrat structurel des micro-décodeurs)", () => {
  it("chaque shader déclare un point d'entrée compute et ses bindings", () => {
    for (const [shader, entryPoint] of [
      [SHADER_DECODE_IMAGE_WAVELET, "fn decoderImage"],
      [SHADER_DECODE_AUDIO_PHASE, "fn decoderAudio"],
      [SHADER_DECODE_VIDEO_DERIVE, "fn deriverTrame"],
    ] as const) {
      expect(shader).toContain("@compute");
      expect(shader).toContain("@workgroup_size");
      expect(shader).toContain(entryPoint);
      expect(shader).toContain("@group(0) @binding(0)");
      expect(shader).toMatch(/var<uniform>/);
      expect(shader).toMatch(/var<storage/);
    }
  });

  it("l'activation sparse est le contrat partagé des trois shaders", () => {
    for (const shader of [SHADER_DECODE_IMAGE_WAVELET, SHADER_DECODE_AUDIO_PHASE, SHADER_DECODE_VIDEO_DERIVE]) {
      expect(shader).toContain("seuilSparse");
    }
    // Le shader image et le shader audio sautent explicitement les nœuds sous seuil.
    expect(SHADER_DECODE_IMAGE_WAVELET).toContain("if (amplitude < params.seuilSparse) { continue; }");
    expect(SHADER_DECODE_AUDIO_PHASE).toContain("if (amplitude < params.seuilSparse) { continue; }");
  });

  it("aucun placeholder dans les shaders (physique réelle uniquement)", () => {
    for (const shader of [SHADER_DECODE_IMAGE_WAVELET, SHADER_DECODE_AUDIO_PHASE, SHADER_DECODE_VIDEO_DERIVE]) {
      expect(shader.toUpperCase()).not.toContain("TODO");
      expect(shader.toLowerCase()).not.toContain("placeholder");
      expect(shader.toLowerCase()).not.toContain("fixme");
    }
  });
});
