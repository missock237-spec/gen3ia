import { describe, expect, it } from "vitest";

import { imagesForModel } from "./vision-input";
import type { MessageAttachment } from "@/lib/domain/conversations/types";

function attachment(overrides: Partial<MessageAttachment>): MessageAttachment {
  return { filename: "fichier", ...overrides };
}

describe("imagesForModel — attachments → AIMessage.images", () => {
  it("retourne undefined sans attachment (aucun champ images émis)", () => {
    expect(imagesForModel(undefined)).toBeUndefined();
    expect(imagesForModel([])).toBeUndefined();
    expect(imagesForModel([attachment({ url: "https://cdn.exemple.com/a.png", contentType: "application/pdf" })])).toBeUndefined();
  });

  it("convertit une URL https d'image en source url", () => {
    const images = imagesForModel([
      attachment({ filename: "photo.png", url: "https://cdn.exemple.com/photo.png", contentType: "image/png" }),
    ]);
    expect(images).toEqual([
      { mediaType: "image/png", source: { type: "url", url: "https://cdn.exemple.com/photo.png" } },
    ]);
  });

  it("convertit une data URI en source base64 (décodée du préfixe data:)", () => {
    const images = imagesForModel([
      attachment({ filename: "inline.png", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" }),
    ]);
    expect(images).toEqual([
      { mediaType: "image/png", source: { type: "base64", data: "iVBORw0KGgoAAAANSUhEUg==" } },
    ]);
  });

  it("écarte http:// (le filtre anti-SSRF n'accepte que https)", () => {
    expect(
      imagesForModel([attachment({ url: "http://cdn.exemple.com/a.png", contentType: "image/png" })]),
    ).toBeUndefined();
  });

  it("ne retient que les formats servis par les modèles vision (svg/heic rejetés)", () => {
    const images = imagesForModel([
      attachment({ filename: "vector.svg", url: "https://a.exemple.com/v.svg", contentType: "image/svg+xml" }),
      attachment({ filename: "photo.heic", url: "https://a.exemple.com/p.heic", contentType: "image/heic" }),
      attachment({ filename: "ok.webp", url: "https://a.exemple.com/ok.webp", contentType: "image/webp" }),
    ]);
    expect(images).toEqual([
      { mediaType: "image/webp", source: { type: "url", url: "https://a.exemple.com/ok.webp" } },
    ]);
  });

  it("normalise image/jpg → image/jpeg", () => {
    const images = imagesForModel([
      attachment({ filename: "votre.jpg", url: "https://a.exemple.com/votre.jpg", contentType: "image/jpg" }),
    ]);
    expect(images?.[0]?.mediaType).toBe("image/jpeg");
  });

  it("déduit le mediaType depuis l'extension quand le content-type manque", () => {
    const images = imagesForModel([attachment({ filename: "sans-type.jpeg", url: "https://a.exemple.com/sans-type.jpeg" })]);
    expect(images?.[0]?.mediaType).toBe("image/jpeg");
  });

  it("écarte une URL https sans aucun signal image (ni content-type ni extension)", () => {
    expect(imagesForModel([attachment({ filename: "notes", url: "https://a.exemple.com/telechargement/123" })])).toBeUndefined();
  });

  it("ignore un attachment réduit à une clé R2 (path sans url — résolution serveur hors contrat pur)", () => {
    expect(imagesForModel([attachment({ filename: "r2.png", path: "users/u1/permanent/r2.png", contentType: "image/png" })])).toBeUndefined();
  });

  it("plafonne au nombre d'images accepté par le filtre de contenu (MAX_IMAGES_PER_REQUEST)", async () => {
    const { MAX_IMAGES_PER_REQUEST } = await import("./content-filter");
    const many = Array.from({ length: MAX_IMAGES_PER_REQUEST + 2 }, (_, i) =>
      attachment({ filename: `i${i}.png`, url: `https://a.exemple.com/i${i}.png`, contentType: "image/png" }),
    );
    const images = imagesForModel(many);
    expect(images).toHaveLength(MAX_IMAGES_PER_REQUEST);
  });
});
