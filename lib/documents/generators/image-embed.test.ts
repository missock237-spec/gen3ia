import { describe, expect, it } from "vitest";

import { chargerImageBloc, dimensionsJpeg, dimensionsPng } from "./image-embed";

/**
 * EMBARQUEMENT D'IMAGES DANS LES LIVRABLES (audit multimodal, axe C) :
 * le bloc `image` du DocumentPlan était avalisé puis perdu — vérifier la
 * chaîne pure qui le rend réel :
 *  1. lecture des dimensions PNG (IHDR) et JPEG (SOF) par magic bytes —
 *     sans sharp, sans réseau, déterministe ;
 *  2. charge data URI 1×1 (chemin PNG direct, sans conversion) ;
 *  3. repli fail-soft : source invalide/inaccessible → null (jamais de
 *     throw — le livrable part toujours, avec cadre de repli).
 */

/** PNG 1×1 valide (signature + IHDR + IDAT + IEND) en base64. */
const PNG_1PX_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Fabrique un buffer PNG minimal (signature + IHDR dimensionné). */
function pngMinimal(largeur: number, hauteur: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(21);
  ihdr.writeUInt32BE(13, 0); // longueur du chunk IHDR
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(largeur, 8);
  ihdr.writeUInt32BE(hauteur, 12);
  ihdr[16] = 8; // profondeur
  ihdr[17] = 6; // RGBA
  return Buffer.concat([signature, ihdr, Buffer.alloc(12)]);
}

/** Fabrique un buffer JPEG minimal (SOI + segment SOF0 dimensionné). */
function jpegMinimal(largeur: number, hauteur: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0; // SOF0
  sof.writeUInt16BE(17, 2); // longueur du segment
  sof[4] = 8; // précision
  sof.writeUInt16BE(hauteur, 5);
  sof.writeUInt16BE(largeur, 7);
  return Buffer.concat([soi, sof, Buffer.from([0xff, 0xd9])]);
}

describe("dimensionsPng / dimensionsJpeg — lecture par magic bytes", () => {
  it("lit les dimensions d'un PNG (IHDR gros-boutiste)", () => {
    const dims = dimensionsPng(pngMinimal(1024, 768));
    expect(dims).toEqual({ largeur: 1024, hauteur: 768 });
  });

  it("rejette un buffer non-PNG ou tronqué", () => {
    expect(dimensionsPng(Buffer.from("pas un png"))).toBeNull();
    expect(dimensionsPng(Buffer.alloc(10))).toBeNull();
  });

  it("lit les dimensions d'un JPEG (marqueur SOF0)", () => {
    const dims = dimensionsJpeg(jpegMinimal(1920, 1080));
    expect(dims).toEqual({ largeur: 1920, hauteur: 1080 });
  });

  it("rejette un JPEG sans SOF exploitable", () => {
    expect(dimensionsJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});

describe("chargerImageBloc — charge et prépare une image de bloc", () => {
  it("charge un data URI PNG 1×1 (chemin direct sans sharp)", async () => {
    const image = await chargerImageBloc({
      url: `data:image/png;base64,${PNG_1PX_BASE64}`,
    });
    expect(image).not.toBeNull();
    expect(image?.mime).toBe("image/png");
    expect(image?.largeurPx).toBe(1);
    expect(image?.hauteurPx).toBe(1);
    expect(image?.buffer.length).toBeGreaterThan(0);
  });

  it("retourne null pour un data URI invalide ou non-image (fail-soft)", async () => {
    expect(await chargerImageBloc({ url: "data:text/plain;base64,SGVsbG8=" })).toBeNull();
    expect(await chargerImageBloc({ url: "data:image/png;base64,###" })).toBeNull();
    expect(await chargerImageBloc({ url: undefined })).toBeNull();
    expect(await chargerImageBloc({})).toBeNull();
  });

  it("retourne null pour une URL http injoignable (fail-soft, jamais throw)", async () => {
    const image = await chargerImageBloc({
      url: "http://127.0.0.1:9/image-injoignable.png",
    });
    expect(image).toBeNull();
  });

  it("retourne null pour une source non reconnue (clé R2 brute hors schéma zod .url())", async () => {
    expect(await chargerImageBloc({ url: "users/u1/permanent/x.png" })).toBeNull();
  });
});
