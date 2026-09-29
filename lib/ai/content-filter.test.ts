import { describe, expect, it } from "vitest";

import {
  MAX_IMAGES_PER_REQUEST,
  validateImageAttachments,
} from "./content-filter";

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
const BIG_PNG = Buffer.alloc(6 * 1024 * 1024, 7).toString("base64");

describe("validateImageAttachments — filtre de contenu vision", () => {
  it("accepte une liste vide", () => {
    expect(validateImageAttachments(undefined)).toEqual({ ok: true, errors: [], accepted: 0 });
    expect(validateImageAttachments([])).toEqual({ ok: true, errors: [], accepted: 0 });
  });

  it("accepte des images base64 valides", () => {
    const result = validateImageAttachments([
      { mediaType: "image/png", source: { type: "base64", data: PNG_BASE64 } },
      { mediaType: "image/jpeg", source: { type: "base64", data: PNG_BASE64 } },
    ]);
    expect(result.ok).toBe(true);
    expect(result.accepted).toBe(2);
  });

  it("refuse un format non supporté", () => {
    const result = validateImageAttachments([
      { mediaType: "image/bmp" as never, source: { type: "base64", data: PNG_BASE64 } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("non supporté");
  });

  it("refuse une image trop lourde (taille binaire réelle)", () => {
    const result = validateImageAttachments([
      { mediaType: "image/png", source: { type: "base64", data: BIG_PNG } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/Mo/);
  });

  it("refuse un base64 invalide", () => {
    const result = validateImageAttachments([
      { mediaType: "image/png", source: { type: "base64", data: "!!!pas-base64!!!" } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("base64 invalide");
  });

  it("accepte une URL https et refuse le reste (anti-SSRF)", () => {
    const ok = validateImageAttachments([
      { mediaType: "image/webp", source: { type: "url", url: "https://cdn.example.com/a.webp" } },
    ]);
    expect(ok.ok).toBe(true);

    for (const url of ["http://insecure.example.com/a.png", "file:///etc/passwd", "data:image/png;base64,AAAA", "javascript:alert(1)"]) {
      const result = validateImageAttachments([
        { mediaType: "image/png", source: { type: "url", url } },
      ]);
      expect(result.ok).toBe(false);
    }
  });

  it("refuse plus de MAX_IMAGES_PER_REQUEST images", () => {
    const images = Array.from({ length: MAX_IMAGES_PER_REQUEST + 1 }, () => ({
      mediaType: "image/png" as const,
      source: { type: "base64" as const, data: PNG_BASE64 },
    }));
    const result = validateImageAttachments(images);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("Trop d'images");
  });
});
