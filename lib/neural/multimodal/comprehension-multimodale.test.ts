/**
 * TESTS DU LOT 6 — compréhension multimodale locale. Les médias de test
 * sont RÉELS : un PNG généré par sharp (dépendance locale du dépôt), un
 * WAV PCM 16 bits mono construit octet par octet (le format réel de
 * l'effecteur audio du cerveau), une animation SVG SMIL du format natif
 * du générateur vidéo. Les refus honnêtes sont aussi testés.
 */

import { describe, expect, it } from "vitest";

import { comprendreAudioWav, comprendreImage, comprendreVideoSmil, surfaceMultimodal } from "./comprehension-multimodale";

/** Construit un WAV PCM 16 bits mono RÉEL (en-tête RIFF + échantillons). */
function wavMono(sinusHz: number, dureeS = 0.2, sampleRate = 8_000, amplitude = 20_000): Buffer {
  const nbEch = Math.floor(dureeS * sampleRate);
  const tailleData = nbEch * 2;
  const buffer = Buffer.alloc(44 + tailleData);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + tailleData, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(tailleData, 40);
  for (let i = 0; i < nbEch; i++) {
    const t = i / sampleRate;
    const v = Math.round(amplitude * Math.sin(2 * Math.PI * sinusHz * t));
    buffer.writeInt16LE(v, 44 + i * 2);
  }
  return buffer;
}

describe("LOT 6 — IMAGE (sharp local, analyse réelle)", () => {
  it("un PNG réel est compris : dimensions, luminance, dominante, bords", async () => {
    const sharp = (await import("sharp")).default;
    // Image de test RÉELLE : rectangle bleu sur fond clair (éclairage moyen,
    // bords nets aux frontières).
    const png = await sharp({
      create: { width: 100, height: 80, channels: 3, background: { r: 220, g: 224, b: 232 } },
    })
      .composite([{ input: Buffer.from(`<svg width="50" height="40"><rect width="50" height="40" fill="rgb(30,60,180)"/></svg>`), left: 25, top: 20 }])
      .png()
      .toBuffer();
    const c = await comprendreImage(png);
    expect(c.comprise).toBe(true);
    expect(c.largeur).toBe(100);
    expect(c.hauteur).toBe(80);
    expect(c.luminanceMoyenne).toBeGreaterThan(60);
    expect(c.luminanceMoyenne).toBeLessThan(255);
    expect(c.contraste).toBeGreaterThan(0); // le rectangle bleu crée du contraste
    expect(c.densiteBords).toBeGreaterThan(0); // des bords réels existent
    expect(c.interpretation).toContain("dominante");
  });

  it("une image unie sombre est interprétée honnêtement (sombre, lisse)", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 12, g: 14, b: 16 } } }).png().toBuffer();
    const c = await comprendreImage(png);
    expect(c.luminanceMoyenne).toBeLessThan(60);
    expect(c.interpretation).toContain("sombre");
    expect(c.interpretation).toContain("lisses"); // pas de bords dans une image unie
  });

  it("un buffer non-image est REFUSÉ honnêtement (jamais de fausse analyse)", async () => {
    await expect(comprendreImage(Buffer.from("ceci n'est pas une image"))).rejects.toThrow();
  });
});

describe("LOT 6 — AUDIO (WAV PCM 16 bits mono, analyse réelle)", () => {
  it("un WAV tonal réel est compris : durée, RMS, classe tonale, centre spectral", () => {
    const c = comprendreAudioWav(wavMono(440, 0.25, 8_000));
    expect(c.comprise).toBe(true);
    expect(c.dureeSecondes).toBeCloseTo(0.25, 1);
    expect(c.sampleRate).toBe(8_000);
    expect(c.rms).toBeGreaterThan(0.3); // sinusoïde pleine amplitude
    expect(c.classe).toBe("tonal"); // ZCR faible pour une sinusoïde 440 Hz
    expect(c.centreSpectralHz).toBeGreaterThan(200);
    expect(c.centreSpectralHz).toBeLessThan(1_000); // proche de 440±bins
  });

  it("un WAV silencieux (échantillons à zéro) est classé silence", () => {
    const c = comprendreAudioWav(wavMono(440, 0.1, 8_000, 0));
    expect(c.rms).toBe(0);
    expect(c.classe).toBe("silence");
  });

  it("un WAV de bruit (ZCR élevé) est classé bruit", () => {
    const sampleRate = 8_000;
    const nbEch = 1_600;
    const buffer = Buffer.alloc(44 + nbEch * 2);
    buffer.write("RIFF", 0, "ascii");
    buffer.writeUInt32LE(36 + nbEch * 2, 4);
    buffer.write("WAVE", 8, "ascii");
    buffer.write("fmt ", 12, "ascii");
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36, "ascii");
    buffer.writeUInt32LE(nbEch * 2, 40);
    // Alternance déterministe du signe à chaque échantillon → ZCR ≈ 1
    // (LCG interdit ici : la précision JS > 2^31 fausse la parité).
    for (let i = 0; i < nbEch; i++) {
      buffer.writeInt16LE(i % 2 === 0 ? 25_000 : -25_000, 44 + i * 2);
    }
    const c = comprendreAudioWav(buffer);
    expect(c.tauxPassageZero).toBeGreaterThan(0.4);
    expect(c.classe).toBe("bruit");
  });

  it("un non-WAV est REFUSÉ honnêtement", () => {
    expect(() => comprendreAudioWav(Buffer.from("passepartout"))).toThrow(/pas un fichier WAV/);
  });
});

describe("LOT 6 — VIDÉO (SMIL natif du cerveau, refus honnête des conteneurs)", () => {
  it("une animation SMIL du cerveau est comprise : durée, animations, éléments", () => {
    const smil = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
      <rect width="640" height="360" fill="#101020"/>
      <circle cx="80" cy="80" r="12" fill="#ffcc00">
        <animate attributeName="cx" values="80;560;80" dur="4s" repeatCount="indefinite"/>
      </circle>
      <text x="20" y="330" fill="#ffffff">cycle neuronal</text>
      <animateTransform attributeName="transform" type="rotate" dur="6s"/>
    </svg>`;
    const c = comprendreVideoSmil(smil);
    expect(c.comprise).toBe(true);
    expect(c.dureeSecondes).toBe(4);
    expect(c.nbAnimations).toBe(2);
    expect(c.nbElements).toBe(3);
  });

  it("un conteneur exogène (mp4) est REFUSÉ honnêtement (pas de décodeur local)", () => {
    expect(() => comprendreVideoSmil(Buffer.from("\u0000\u0000\u0000 ftypisom....mp4"))).toThrow(/refus honnête/);
  });
});

describe("LOT 6 — surface du module", () => {
  it("trois analyseurs locaux, formats natifs déclarés", () => {
    const s = surfaceMultimodal();
    expect(s.analyseurs).toBe(3);
    expect(s.formatsNatifs).toContain("wav-pcm16-mono");
    expect(s.formatsNatifs).toContain("svg-smil");
  });
});
