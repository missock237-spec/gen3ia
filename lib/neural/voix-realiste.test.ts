import { describe, expect, it } from "vitest";
import { CHAINE_VOIX_REALISTE, polirVoixRealiste } from "./voix-realiste";

/** WAV PCM16 mono 8 kHz — 1 s de sinus (fixture audio valide, ~16 Ko). */
function wavSinus(secondes: number, frequenceHz = 440): Buffer {
  const taux = 8000;
  const echantillons = Math.round(taux * secondes);
  const donnees = Buffer.alloc(echantillons * 2);
  for (let i = 0; i < echantillons; i += 1) {
    donnees.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequenceHz * i) / taux) * 12000), i * 2);
  }
  const entete = Buffer.alloc(44);
  entete.write("RIFF", 0, "ascii");
  entete.writeUInt32LE(36 + donnees.length, 4);
  entete.write("WAVEfmt ", 8, "ascii");
  entete.writeUInt32LE(16, 16);
  entete.writeUInt16LE(1, 20); // PCM
  entete.writeUInt16LE(1, 22); // mono
  entete.writeUInt32LE(taux, 24);
  entete.writeUInt32LE(taux * 2, 28); // byte rate
  entete.writeUInt16LE(2, 32); // block align
  entete.writeUInt16LE(16, 34); // bits
  entete.write("data", 36, "ascii");
  entete.writeUInt32LE(donnees.length, 40);
  return Buffer.concat([entete, donnees]);
}

describe("voix-realiste — réalisme audio automatique (2026-11-14)", () => {
  it("la chaîne de filtres couvre EQ, compression, salle et loudness", () => {
    expect(CHAINE_VOIX_REALISTE).toContain("highpass=f=75");
    expect(CHAINE_VOIX_REALISTE).toContain("acompressor");
    expect(CHAINE_VOIX_REALISTE).toContain("aecho");
    expect(CHAINE_VOIX_REALISTE).toContain("loudnorm");
  });

  it("polis un WAV réel → MP3 poli (FFmpeg réel du bac à sable)", async () => {
    const source = wavSinus(1);
    const résultat = await polirVoixRealiste({ buffer: source, mime: "audio/wav" });
    expect(résultat.poli).toBe(true);
    expect(résultat.mime).toBe("audio/mpeg");
    expect(résultat.buffer.length).toBeGreaterThan(512);
  }, 30_000);

  it("flux trop court → repli honnête voix brute (jamais bloquant)", async () => {
    const petit = Buffer.alloc(64, 1);
    const résultat = await polirVoixRealiste({ buffer: petit, mime: "audio/wav" });
    expect(résultat.poli).toBe(false);
    expect(résultat.buffer).toBe(petit);
    expect(résultat.mime).toBe("audio/wav");
    expect(résultat.detail).toBeTruthy();
  });

  it("flux corrompu → repli voix brute avec détail (aucune exception sortie)", async () => {
    const corrompu = Buffer.concat([Buffer.from("ID3", "ascii"), Buffer.alloc(2048, 1)]);
    const résultat = await polirVoixRealiste({ buffer: corrompu, mime: "audio/mpeg" });
    expect(résultat.poli).toBe(false);
    expect(résultat.buffer).toBe(corrompu);
    expect(résultat.detail).toBeTruthy();
  }, 30_000);
});
