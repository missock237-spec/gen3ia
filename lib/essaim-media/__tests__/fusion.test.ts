import { describe, expect, it } from "vitest";

import { concaténerWav } from "../wav";
import { construireGrapheXfade } from "../fusion";

/** Fabrique un WAV PCM canonique (en-tête 44 octets + data). */
function fabriquerWav(
  échantillons: Float32Array,
  taux = 24000,
  canaux = 1,
  format: 1 | 3 = 1,
): Uint8Array {
  const bits = format === 3 ? 32 : 16;
  const octetsParÉch = bits / 8;
  const data = new Uint8Array(échantillons.length * octetsParÉch);
  const dv = new DataView(data.buffer);
  for (let i = 0; i < échantillons.length; i++) {
    if (format === 3) dv.setFloat32(i * 4, échantillons[i], true);
    else dv.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, échantillons[i])) * 32767), true);
  }
  const out = new Uint8Array(44 + data.length);
  const v = new DataView(out.buffer);
  const écrire4 = (o: number, s: string): void => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  écrire4(0, "RIFF");
  v.setUint32(4, 36 + data.length, true);
  écrire4(8, "WAVE");
  écrire4(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, format, true);
  v.setUint16(22, canaux, true);
  v.setUint32(24, taux, true);
  v.setUint32(28, taux * canaux * octetsParÉch, true);
  v.setUint16(32, canaux * octetsParÉch, true);
  v.setUint16(34, bits, true);
  écrire4(36, "data");
  v.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

describe("concaténerWav (fusion des signaux voix)", () => {
  it("un seul segment = passage direct à l'identique", () => {
    const wav = fabriquerWav(new Float32Array([0.1, -0.2, 0.3]));
    expect(concaténerWav([wav])).toBe(wav);
  });

  it("deux segments PCM16 : fondu de 60 ms, en-tête et longueur exacts", () => {
    const taux = 24000;
    const a = new Float32Array(4800).fill(0.5); // 200 ms
    const b = new Float32Array(2400).fill(-0.5); // 100 ms
    const fusion = concaténerWav([fabriquerWav(a, taux), fabriquerWav(b, taux)]);
    // En-tête RIFF/WAVE + PCM 16 bits mono.
    const dv = new DataView(fusion.buffer);
    expect(String.fromCharCode(fusion[0], fusion[1], fusion[2], fusion[3])).toBe("RIFF");
    expect(String.fromCharCode(fusion[8], fusion[9], fusion[10], fusion[11])).toBe("WAVE");
    expect(dv.getUint16(20, true)).toBe(1);
    expect(dv.getUint32(24, true)).toBe(taux);
    // Longueur : a + b − fondu (60 ms = 1440 échantillons PCM16).
    const nbFondu = Math.round((60 / 1000) * taux);
    const attendu = a.length + b.length - nbFondu;
    expect(dv.getUint32(40, true)).toBe(attendu * 2);
  });

  it("le fondu d'égalité de puissance évite le clic : valeur au milieu du fondu composée", () => {
    const taux = 24000;
    const a = new Float32Array(4800).fill(1);
    const b = new Float32Array(4800).fill(1);
    const fusion = concaténerWav([fabriquerWav(a, taux), fabriquerWav(b, taux)]);
    const dv = new DataView(fusion.buffer);
    const nbFondu = Math.round((60 / 1000) * taux);
    // Au milieu du fondu : cos(45°)·1 + sin(45°)·1 ≈ 1.414 → saturé à 1 par l'encodeur.
    const milieu = 4800 - nbFondu + Math.floor(nbFondu / 2);
    const échantillon = dv.getInt16(44 + milieu * 2, true) / 32768;
    expect(échantillon).toBeLessThanOrEqual(1);
    expect(échantillon).toBeGreaterThan(0.9);
  });

  it("formats hétérogènes (taux différents) refusés — jamais de WAV corrompu", () => {
    const a = fabriquerWav(new Float32Array(1000), 24000);
    const b = fabriquerWav(new Float32Array(1000), 16000);
    expect(() => concaténerWav([a, b])).toThrow(/hétérogènes/);
  });

  it("float32 accepté (format 3) et converti en PCM16", () => {
    const a = fabriquerWav(new Float32Array(2000).fill(0.25), 24000, 1, 3);
    const b = fabriquerWav(new Float32Array(2000).fill(0.25), 24000, 1, 3);
    const fusion = concaténerWav([a, b]);
    const dv = new DataView(fusion.buffer);
    expect(dv.getUint16(20, true)).toBe(1); // sortie PCM16 canonique
    expect(fusion.byteLength).toBeGreaterThan(44);
  });

  it("un seul segment stéréo = passage direct (pas de remaniement inutile)", () => {
    const stéréo = new Float32Array(2000);
    for (let i = 0; i < 1000; i++) {
      stéréo[i * 2] = 0.5;
      stéréo[i * 2 + 1] = -0.5;
    }
    const fusion = concaténerWav([fabriquerWav(stéréo, 24000, 2)]);
    expect(fusion).toBe(fusion); // identité : le buffer d'origine est retourné
  });

  it("deux segments stéréo mixés en mono", () => {
    const stéréo = new Float32Array(2000); // 1000 frames × 2 canaux
    for (let i = 0; i < 1000; i++) {
      stéréo[i * 2] = 0.5;
      stéréo[i * 2 + 1] = -0.5; // annulation → mono ≈ 0
    }
    const wav = fabriquerWav(stéréo, 24000, 2);
    const fusion = concaténerWav([wav, fabriquerWav(stéréo, 24000, 2)]);
    const dv = new DataView(fusion.buffer);
    expect(dv.getUint16(22, true)).toBe(1); // mono en sortie
    const premier = dv.getInt16(44, true) / 32768;
    expect(Math.abs(premier)).toBeLessThan(0.01);
  });

  it("aucun buffer → erreur explicite", () => {
    expect(() => concaténerWav([])).toThrow(/Aucun segment/);
  });
});

describe("construireGrapheXfade (fusion des signaux vidéo)", () => {
  it("keyframe unique : pas de xfade", () => {
    expect(construireGrapheXfade(1, 1.6, 0.5)).toBe("[0:v]fps=24,format=yuv420p[vfinal]");
  });

  it("3 keyframes : 2 fondus enchaînés avec offsets cumulés exacts", () => {
    const graphe = construireGrapheXfade(3, 1.6, 0.5);
    const parts = graphe.split(";");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("[0:v][1:v]xfade=transition=fade:duration=0.5:offset=1.10[v1]");
    expect(parts[1]).toBe("[v1][2:v]xfade=transition=fade:duration=0.5:offset=2.20[vchaîne]");
    expect(parts[2]).toBe("[vchaîne]fps=24,format=yuv420p[vfinal]");
  });

  it("8 keyframes (haute qualité) : chaîne complète", () => {
    const graphe = construireGrapheXfade(8, 1.6, 0.5);
    expect((graphe.match(/xfade=/g) ?? []).length).toBe(7);
    expect(graphe.endsWith("[vfinal]")).toBe(true);
  });
});
