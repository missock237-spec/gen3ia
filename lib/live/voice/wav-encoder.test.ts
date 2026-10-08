import { describe, expect, it } from "vitest";

import { encodeWav, WAV_HEADER_BYTES } from "@/lib/live/voice/wav-encoder";

/** Lit l'entête du Blob en Uint8Array (Blob disponible en Node ≥ 18). */
async function octets(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe("encodeWav", () => {
  it("produit un WAV de 44 octets d'entête même sans données", async () => {
    const blob = encodeWav([], 16_000);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(WAV_HEADER_BYTES);
    const bytes = await octets(blob);
    expect(bytes.length).toBe(44);
    // RIFF size = taille fichier - 8 = 36.
    expect(new DataView(bytes.buffer).getUint32(4, true)).toBe(36);
  });

  it("écrit l'entête RIFF/Wave canonique PCM16 mono (golden)", async () => {
    const blob = encodeWav([Int16Array.of(0x1234, -1)], 16_000);
    const bytes = await octets(blob);

    // Identifiants ASCII attendus aux offsets canoniques.
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...bytes.subarray(offset, offset + length));
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(ascii(36, 4)).toBe("data");

    const view = new DataView(bytes.buffer);
    expect(view.getUint32(4, true)).toBe(36 + 4); // RIFF size
    expect(view.getUint32(16, true)).toBe(16); // taille du bloc fmt
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000); // sampleRate
    expect(view.getUint32(28, true)).toBe(32_000); // byteRate
    expect(view.getUint16(32, true)).toBe(2); // blockAlign
    expect(view.getUint16(34, true)).toBe(16); // bits par échantillon
    expect(view.getUint32(40, true)).toBe(4); // taille data (2 échantillons × 2)
  });

  it("écrit les échantillons en PCM16 little-endian (golden octets)", async () => {
    const blob = encodeWav([Int16Array.of(0x1234, -1)], 16_000);
    const bytes = await octets(blob);
    // 0x1234 → 34 12 ; -1 → ff ff.
    expect(Array.from(bytes.slice(44))).toEqual([0x34, 0x12, 0xff, 0xff]);
  });

  it("concatène plusieurs trames dans l'ordre chronologique", async () => {
    const blob = encodeWav([Int16Array.of(100), Int16Array.of(200, 300), Int16Array.of(-500)], 16_000);
    expect(blob.size).toBe(44 + 8);
    const bytes = await octets(blob);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(40, true)).toBe(8); // 4 échantillons × 2 octets
    expect(view.getInt16(44, true)).toBe(100);
    expect(view.getInt16(46, true)).toBe(200);
    expect(view.getInt16(48, true)).toBe(300);
    expect(view.getInt16(50, true)).toBe(-500);
  });

  it("utilise 16 000 Hz par défaut et respecte la fréquence fournie", async () => {
    const defaut = new DataView((await octets(encodeWav([Int16Array.of(1)])).then((b) => b.buffer)));
    expect(defaut.getUint32(24, true)).toBe(16_000);

    const custom = new DataView((await octets(encodeWav([Int16Array.of(1)], 48_000)).then((b) => b.buffer)));
    expect(custom.getUint32(24, true)).toBe(48_000);
    expect(custom.getUint32(28, true)).toBe(96_000); // byteRate = 48000 × 2
  });

  it("dimensionne le fichier : 44 octets + 2 octets par échantillon", async () => {
    const trame = new Int16Array(16_000); // 1 s de silence à 16 kHz
    const blob = encodeWav([trame], 16_000);
    expect(blob.size).toBe(44 + 16_000 * 2);
  });
});
