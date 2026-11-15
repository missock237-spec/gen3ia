import { describe, expect, it } from "vitest";

import { snifferContentTypeMedia } from "./analyze";

/**
 * ANALYSE MÉDIA LOCALE (audit multimodal, axe B) — la lecture des médias
 * joints commence par une détection de type FIABLE par magic bytes (l'annonce
 * du navigateur peut mentir : un .wav renommé .pdf doit être vu comme audio).
 * Tests purs : aucune E/S, aucun binaire externe — les en-têtes sont forgés.
 */

/** En-têtes magic bytes forgés pour chaque famille. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const WAV = Buffer.concat([Buffer.from("RIFF----WAVEfmt "), Buffer.alloc(8)]);
const MP3_ID3 = Buffer.concat([Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00"), Buffer.alloc(8)]);
const OGG = Buffer.concat([Buffer.from("OggS\x00\x02\x00\x00"), Buffer.alloc(8)]);
const FLAC = Buffer.concat([Buffer.from("fLaC\x00\x00\x00\x22"), Buffer.alloc(8)]);
const MP4 = Buffer.concat([Buffer.alloc(4, 0x00), Buffer.from("ftypisom"), Buffer.alloc(8)]);
const M4A = Buffer.concat([Buffer.alloc(4, 0x00), Buffer.from("ftypM4A "), Buffer.alloc(8)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12)]);

describe("snifferContentTypeMedia — détection par magic bytes", () => {
  it("détecte les images (PNG, JPEG) quelle que soit l'annonce", () => {
    expect(snifferContentTypeMedia(PNG, "application/pdf")).toBe("image/png");
    expect(snifferContentTypeMedia(JPEG, "audio/mpeg")).toBe("image/jpeg");
  });

  it("détecte les audios (WAV, MP3/ID3, OGG, FLAC, M4A)", () => {
    expect(snifferContentTypeMedia(WAV, "")).toBe("audio/wav");
    expect(snifferContentTypeMedia(MP3_ID3, "application/octet-stream")).toBe("audio/mpeg");
    expect(snifferContentTypeMedia(OGG, "")).toBe("audio/ogg");
    expect(snifferContentTypeMedia(FLAC, "")).toBe("audio/flac");
    expect(snifferContentTypeMedia(M4A, "video/mp4")).toBe("audio/mp4");
  });

  it("détecte les vidéos (MP4 ftyp générique, WebM/EBML)", () => {
    expect(snifferContentTypeMedia(MP4, "")).toBe("video/mp4");
    expect(snifferContentTypeMedia(WEBM, "application/octet-stream")).toBe("video/webm");
  });

  it("retombe sur le mime annoncé pour un inconnu, nettoyé et minuscule", () => {
    expect(snifferContentTypeMedia(Buffer.from("XXXX"), "Application/PDF; charset=utf-8")).toBe("application/pdf");
    expect(snifferContentTypeMedia(Buffer.alloc(4), "")).toBe("application/octet-stream");
  });

  it("un média renommé (.wav → .pdf) est bien vu comme audio", () => {
    // L'annonce trompeuse ne gagne JAMAIS contre les magic bytes.
    expect(snifferContentTypeMedia(WAV, "application/pdf")).toBe("audio/wav");
  });
});
