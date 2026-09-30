import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Étape 8 du plan 20 — résolution des sources d'images éditables.
 * Les fonctions réseau (fetch, R2) sont mockées ; la logique de sélection
 * (data URI direct, URL → fetch, clé permanente → R2, plafonds, résilience)
 * est vérifiée réellement.
 */

vi.mock("@/lib/storage/r2", () => ({
  isR2Configured: vi.fn(() => true),
  downloadFromR2: vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])),
}));

import { downloadFromR2 } from "@/lib/storage/r2";
import {
  attachmentImageCandidates,
  isDataUriImage,
  isHttpUrl,
  isPermanentPath,
  resolveEditableImageSources,
  resolveImageSource,
  sniffImageContentType,
} from "./image-source";

const PNG_DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("classificateurs purs", () => {
  it("isDataUriImage n'accepte que les Data URI image base64 plausibles", () => {
    expect(isDataUriImage(PNG_DATA_URI)).toBe(true);
    expect(isDataUriImage("data:text/html;base64,PGI+")).toBe(false);
    expect(isDataUriImage("data:image/png;base64,!!!invalide!!!")).toBe(false);
    expect(isDataUriImage("https://exemple.com/a.png")).toBe(false);
  });

  it("isHttpUrl / isPermanentPath distinguent URL et clé de stockage", () => {
    expect(isHttpUrl("https://exemple.com/a.png")).toBe(true);
    expect(isHttpUrl("users/u1/permanent/a.png")).toBe(false);
    expect(isPermanentPath("users/u1/permanent/imported-images/a.png")).toBe(true);
    expect(isPermanentPath("https://exemple.com/a.png")).toBe(false);
    expect(isPermanentPath("users/../etc/passwd")).toBe(false);
  });

  it("sniffImageContentType reconnaît les magic bytes (PNG, JPEG, GIF, WEBP)", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(sniffImageContentType(jpeg)).toBe("image/jpeg");
    const gif = Buffer.from("GIF89a", "latin1");
    expect(sniffImageContentType(gif)).toBe("image/gif");
    const riff = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBP", "latin1")]);
    expect(sniffImageContentType(riff)).toBe("image/webp");
    expect(sniffImageContentType(Buffer.from("inconnu"))).toBe("image/png");
  });
});

describe("resolveImageSource", () => {
  it("utilise un Data URI image tel quel (aucun réseau)", () => {
    const source = resolveImageSource(PNG_DATA_URI);
    return expect(source).resolves.toEqual({ raw: PNG_DATA_URI.slice(0, 64), dataUri: PNG_DATA_URI });
  });

  it("récupère une URL http(s) et la convertit en Data URI", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    })));
    const source = await resolveImageSource("https://exemple.com/photo.jpg");
    expect(source.dataUri).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("refuse une URL qui ne sert pas une image", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })));
    await expect(resolveImageSource("https://exemple.com/page")).rejects.toThrow(/n'est pas une image/);
  });

  it("télécharge une clé permanente via R2 (authentifié serveur)", async () => {
    const source = await resolveImageSource("users/u1/permanent/imported-images/photo.png");
    expect(downloadFromR2).toHaveBeenCalledWith("users/u1/permanent/imported-images/photo.png", expect.any(Number));
    expect(source.dataUri).toMatch(/^data:image\/png;base64,/);
  });

  it("lève une erreur lisible sur une source vide ou inconnue", async () => {
    await expect(resolveImageSource("")).rejects.toThrow(/vide/);
    await expect(resolveImageSource("fichier-local.png")).rejects.toThrow(/non reconnue/);
  });
});

describe("resolveEditableImageSources", () => {
  it("résout plusieurs sources dans l'ordre", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      status: 200,
      headers: { "content-type": "image/png" },
    })));
    const sources = await resolveEditableImageSources([PNG_DATA_URI, "https://exemple.com/2.png"]);
    expect(sources).toHaveLength(2);
    expect(sources[0]?.dataUri).toBe(PNG_DATA_URI);
  });

  it("saute une source indisponible mais échoue si AUCUNE n'est résoluble", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    await expect(resolveEditableImageSources(["https://exemple.com/cassée.png"])).rejects.toThrow(/Aucune image source exploitable/);
  });
});

describe("attachmentImageCandidates", () => {
  it("propose path (prioritaire) puis url pour une image", () => {
    const candidates = attachmentImageCandidates({
      filename: "photo.jpg",
      contentType: "image/jpeg",
      path: "users/u1/permanent/imported-images/photo.jpg",
      url: "https://exemple.com/photo.jpg",
    });
    expect(candidates).toEqual(["users/u1/permanent/imported-images/photo.jpg", "https://exemple.com/photo.jpg"]);
  });

  it("ignore les non-images", () => {
    expect(attachmentImageCandidates({ filename: "doc.pdf", contentType: "application/pdf", path: "users/u1/x.pdf" })).toEqual([]);
  });
});
