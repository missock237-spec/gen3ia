import { describe, expect, it } from "vitest";

import { estImageConnue, metadonneesImage } from "./image-meta";

// ────────────────────────────────────────────────────────────────────────────
// Métadonnées d'images par SIGNATURE (jamais par extension) : PNG réel 1×1,
// JPEG construit avec SOF0 16×32, WEBP VP8L 5×3, SVG viewBox.
// ────────────────────────────────────────────────────────────────────────────

/** PNG 1×1 transparent — tableau de bytes canonique. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** JPEG minimal : SOI + SOF0 (16×32) + EOI. */
function jpegMinimal(): Buffer {
  const sof = Buffer.alloc(15);
  sof[0] = 0xff; sof[1] = 0xc0; // SOF0
  sof.writeUInt16BE(11, 2); // longueur segment
  sof[4] = 8; // précision
  sof.writeUInt16BE(32, 5); // hauteur
  sof.writeUInt16BE(16, 7); // largeur
  sof[9] = 1; // composantes
  sof[10] = 3; sof[11] = 1; sof[12] = 0x22; sof[13] = 0; sof[14] = 2;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** WEBP VP8L lossless 5×3 : bits = (w-1) | ((h-1) << 14). */
function webpVp8l(largeur: number, hauteur: number): Buffer {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  const bits = (largeur - 1) | ((hauteur - 1) << 14);
  payload.writeUInt32LE(bits, 1);
  const chunk = Buffer.concat([
    Buffer.from("VP8L", "ascii"),
    (() => { const t = Buffer.alloc(4); t.writeUInt32LE(payload.length, 0); return t; })(),
    payload,
  ]);
  const riff = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    (() => { const t = Buffer.alloc(4); t.writeUInt32LE(4 + chunk.length, 0); return t; })(),
    Buffer.from("WEBP", "ascii"),
    chunk,
  ]);
  // Lecteur exige ≥ 30 octets (en-tête VP8X possible) : les VP8L réels
  // comportent des données pixels derrière l'en-tête — on les simule.
  return Buffer.concat([riff, Buffer.alloc(8, 0)]);
}

describe("métadonnées d'images réelles (moteur documentaire)", () => {
  it("lit les dimensions d'un PNG réel 1×1", () => {
    const meta = metadonneesImage(PNG_1X1);
    expect(meta).toEqual({ format: "png", largeur: 1, hauteur: 1 });
    expect(estImageConnue(PNG_1X1)).toBe(true);
  });

  it("lit les dimensions d'un JPEG via le marqueur SOF0", () => {
    const meta = metadonneesImage(jpegMinimal());
    expect(meta).toEqual({ format: "jpeg", largeur: 16, hauteur: 32 });
  });

  it("lit les dimensions d'un WEBP VP8L", () => {
    const meta = metadonneesImage(webpVp8l(5, 3));
    expect(meta).toEqual({ format: "webp", largeur: 5, hauteur: 3 });
  });

  it("lit les dimensions d'un SVG par viewBox", () => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80"><rect width="240" height="80"/></svg>`,
      "utf8",
    );
    const meta = metadonneesImage(svg);
    expect(meta).toEqual({ format: "svg", largeur: 240, hauteur: 80 });
  });

  it("identifie le format PAR SIGNATURE même quand l'extension ment", () => {
    // Un PNG renommé en .jpg reste un PNG — le format lu est png.
    const meta = metadonneesImage(PNG_1X1);
    expect(meta?.format).toBe("png");
  });

  it("renvoie null pour un contenu non image", () => {
    expect(metadonneesImage(Buffer.from("du texte, clairement pas une image", "utf8"))).toBeNull();
    expect(estImageConnue(Buffer.alloc(20, 7))).toBe(false);
  });
});
