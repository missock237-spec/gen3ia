import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests du fallback Hugging Face (Z-Image-Turbo) :
 *  - détection DÉTERMINISTE de la limite de crédit Agnes (code d'erreur) ;
 *  - détection ÉTENDUE (Task 113) : toute INDISPONIBILITÉ TECHNIQUE Agnes
 *    (clé absente/rejetée, panne 5xx, rate-limit 429, timeout, upstream)
 *    déclenche le repli — le résultat est livré au lieu d'un échec ;
 *  - AUCUN repli sur les fautes de saisie (prompt/image invalide) ;
 *  - reprise AUTOMATIQUE de la tâche abandonnée ;
 *  - archivage R2 permanent du résultat HF (ou data URI inline sans R2).
 */

const { textToImageMock } = vi.hoisted(() => ({ textToImageMock: vi.fn() }));

vi.mock("@huggingface/inference", () => ({
  InferenceClient: class {
    textToImage = textToImageMock;
  },
}));

vi.mock("@/lib/storage/r2", () => ({
  isR2Configured: vi.fn(() => true),
  uploadToR2: vi.fn(async () => undefined),
  createR2DownloadUrl: vi.fn(async (key: string) => `https://signed.example/${key}?sig=x`),
}));

// Agnes simulé : la vraie classe ImageGenerationError est conservée pour
// que la détection instanceof du module testé fonctionne.
vi.mock("@/lib/ai/image-generation", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ai/image-generation")>();
  return {
    ...original,
    generateImageWithAgnes: vi.fn(),
  };
});

import { generateImageWithAgnes, ImageGenerationError } from "@/lib/ai/image-generation";
import {
  dimsForRatio,
  generateImageWithFallback,
  generateImageWithHuggingFace,
  isAgnesCreditLimitError,
  isAgnesUnavailableError,
} from "@/lib/ai/hf-image-fallback";
import { createR2DownloadUrl, isR2Configured, uploadToR2 } from "@/lib/storage/r2";

const agnesMock = vi.mocked(generateImageWithAgnes);

function blobFrom(bytes: number[], type = "image/png"): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

beforeEach(() => {
  process.env.HF_TOKEN = "hf-test-token";
  agnesMock.mockReset();
  textToImageMock.mockReset();
  vi.mocked(isR2Configured).mockReturnValue(true);
  vi.mocked(uploadToR2).mockClear();
  vi.mocked(createR2DownloadUrl).mockClear();
});

afterEach(() => {
  delete process.env.HF_TOKEN;
});

describe("détection de la limite de crédit Agnes", () => {
  it("HTTP 402 → crédit épuisé (toujours)", () => {
    expect(isAgnesCreditLimitError(new ImageGenerationError("UPSTREAM_ERROR", "Agnes AI a renvoyé une erreur HTTP 402.", { httpStatus: 402 }))).toBe(true);
  });

  it("message fournisseur nommant le crédit/quota/solde → true", () => {
    expect(isAgnesCreditLimitError(new ImageGenerationError("UPSTREAM_ERROR", "Agnes AI : insufficient credits"))).toBe(true);
    expect(isAgnesCreditLimitError(new ImageGenerationError("UPSTREAM_ERROR", "Agnes AI : votre solde est épuisé"))).toBe(true);
    expect(isAgnesCreditLimitError(new ImageGenerationError("UPSTREAM_ERROR", "Agnes AI : quota exceeded for billing period"))).toBe(true);
  });

  it("les autres erreurs ne déclenchent JAMAIS le repli (contrat CRÉDIT strict)", () => {
    expect(isAgnesCreditLimitError(new ImageGenerationError("TIMEOUT", "trop de temps"))).toBe(false);
    expect(isAgnesCreditLimitError(new ImageGenerationError("INVALID_PROMPT", "prompt invalide"))).toBe(false);
    expect(isAgnesCreditLimitError(new ImageGenerationError("NOT_CONFIGURED", "AGNES_API_KEY manquante"))).toBe(false);
    expect(isAgnesCreditLimitError(new ImageGenerationError("UPSTREAM_ERROR", "Agnes AI a renvoyé une erreur HTTP 500.", { httpStatus: 500 }))).toBe(false);
    expect(isAgnesCreditLimitError(new ImageGenerationError("UPSTREAM_ERROR", "Agnes AI : rate limit, too many requests", { httpStatus: 429 }))).toBe(false);
    expect(isAgnesCreditLimitError(new Error("erreur quelconque"))).toBe(false);
  });

  it("détection ÉLARGIE indisponibilité (Task 113) : crédit + panne technique → repli", () => {
    // Crédit (inclus).
    expect(isAgnesUnavailableError(new ImageGenerationError("UPSTREAM_ERROR", "Agnes AI : insufficient credits"))).toBe(true);
    // Clé absente / rejetée.
    expect(isAgnesUnavailableError(new ImageGenerationError("NOT_CONFIGURED", "AGNES_API_KEY manquante"))).toBe(true);
    expect(isAgnesUnavailableError(new ImageGenerationError("UPSTREAM_ERROR", "clé invalide", { httpStatus: 401 }))).toBe(true);
    expect(isAgnesUnavailableError(new ImageGenerationError("UPSTREAM_ERROR", "interdit", { httpStatus: 403 }))).toBe(true);
    // Panne 5xx / rate-limit / timeout / upstream.
    expect(isAgnesUnavailableError(new ImageGenerationError("UPSTREAM_ERROR", "Agnes AI a renvoyé une erreur HTTP 500.", { httpStatus: 500 }))).toBe(true);
    expect(isAgnesUnavailableError(new ImageGenerationError("UPSTREAM_ERROR", "too many requests", { httpStatus: 429 }))).toBe(true);
    expect(isAgnesUnavailableError(new ImageGenerationError("TIMEOUT", "trop de temps"))).toBe(true);
    expect(isAgnesUnavailableError(new ImageGenerationError("UPSTREAM_ERROR", "upstream broke"))).toBe(true);
    // Fautes de saisie : JAMAIS de repli (le même prompt échouerait pareil).
    expect(isAgnesUnavailableError(new ImageGenerationError("INVALID_PROMPT", "prompt invalide"))).toBe(false);
    expect(isAgnesUnavailableError(new ImageGenerationError("INVALID_IMAGE", "image source invalide"))).toBe(false);
    // Non-ImageGenerationError : pas de repli (le module ne masque rien).
    expect(isAgnesUnavailableError(new Error("erreur quelconque"))).toBe(false);
  });

  it("dimensions par ratio (multiple de 16, plafond 1280)", () => {
    expect(dimsForRatio("1:1")).toEqual({ width: 1024, height: 1024 });
    expect(dimsForRatio("16:9")).toEqual({ width: 1280, height: 720 });
    expect(dimsForRatio("9:16")).toEqual({ width: 720, height: 1280 });
    expect(dimsForRatio("21:9")).toEqual({ width: 1280, height: 544 });
    expect(dimsForRatio(undefined)).toEqual({ width: 1024, height: 1024 });
  });
});

describe("generateImageWithFallback", () => {
  it("Agnes OK → retour direct, Hugging Face JAMAIS appelé", async () => {
    agnesMock.mockResolvedValue({ imageUrl: "https://agnes.example/img.png", model: "agnes-image-2.5-flash", latencyMs: 1200 });
    const result = await generateImageWithFallback({ prompt: "un bébé qui marche", userId: "u1" });
    expect(result.provider).toBe("agnes");
    expect(result.model).toBe("agnes-image-2.5-flash");
    expect(textToImageMock).not.toHaveBeenCalled();
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  it("crédit Agnes épuisé (402) → HF reprend la tâche, archivage R2 permanent", async () => {
    agnesMock.mockRejectedValue(new ImageGenerationError("UPSTREAM_ERROR", "Agnes AI a renvoyé une erreur HTTP 402.", { httpStatus: 402 }));
    textToImageMock.mockResolvedValue(blobFrom([137, 80, 78, 71]));
    const result = await generateImageWithFallback({ prompt: "un bébé qui marche", ratio: "16:9", userId: "u1" });
    expect(result.provider).toBe("huggingface");
    expect(result.model).toContain("Z-Image-Turbo");
    expect(result.storagePath).toMatch(/^users\/u1\/permanent\/ai-images\/hf-/);
    expect(result.imageUrl).toContain("https://signed.example/");
    expect(textToImageMock).toHaveBeenCalledTimes(1);
    expect(uploadToR2).toHaveBeenCalledTimes(1);
    // Ratio transmis aux dimensions HF (1280×720 pour 16:9).
    const call = textToImageMock.mock.calls[0] as [{ model: string; parameters: { width: number; height: number } }, unknown];
    expect(call[0].parameters).toEqual({ width: 1280, height: 720 });
  });

  it("crédit Agnes mais HF non configuré → l'erreur Agnes d'origine est relancée", async () => {
    delete process.env.HF_TOKEN;
    agnesMock.mockRejectedValue(new ImageGenerationError("UPSTREAM_ERROR", "Agnes AI : insufficient credits"));
    await expect(generateImageWithFallback({ prompt: "un logo", userId: "u1" })).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(textToImageMock).not.toHaveBeenCalled();
  });

  it("indisponibilité technique (timeout, 5xx, 401, 429) → HF reprend la tâche (Task 113)", async () => {
    for (const agnesError of [
      new ImageGenerationError("TIMEOUT", "trop de temps"),
      new ImageGenerationError("UPSTREAM_ERROR", "Agnes AI a renvoyé une erreur HTTP 500.", { httpStatus: 500 }),
      new ImageGenerationError("UPSTREAM_ERROR", "clé rejetée", { httpStatus: 401 }),
      new ImageGenerationError("UPSTREAM_ERROR", "too many requests", { httpStatus: 429 }),
      new ImageGenerationError("NOT_CONFIGURED", "AGNES_API_KEY manquante"),
    ]) {
      agnesMock.mockReset();
      textToImageMock.mockReset();
      agnesMock.mockRejectedValue(agnesError);
      textToImageMock.mockResolvedValue(blobFrom([137, 80, 78, 71]));
      const result = await generateImageWithFallback({ prompt: "un logo", userId: "u1" });
      expect(result.provider).toBe("huggingface");
      expect(textToImageMock).toHaveBeenCalledTimes(1);
    }
  });

  it("faute de saisie (prompt invalide) → échec honnête, HF jamais appelé", async () => {
    agnesMock.mockRejectedValue(new ImageGenerationError("INVALID_PROMPT", "prompt invalide"));
    await expect(generateImageWithFallback({ prompt: "un logo", userId: "u1" })).rejects.toMatchObject({ code: "INVALID_PROMPT" });
    expect(textToImageMock).not.toHaveBeenCalled();
  });

  it("HF échoue après crédit Agnes → l'erreur HF est relancée (honnêteté)", async () => {
    agnesMock.mockRejectedValue(new ImageGenerationError("UPSTREAM_ERROR", "Agnes AI a renvoyé une erreur HTTP 402.", { httpStatus: 402 }));
    textToImageMock.mockRejectedValue(new Error("provider unavailable"));
    await expect(generateImageWithFallback({ prompt: "un logo", userId: "u1" })).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(textToImageMock).toHaveBeenCalledTimes(1);
  });

  it("R2 non configuré + image légère → data URI inline", async () => {
    agnesMock.mockRejectedValue(new ImageGenerationError("UPSTREAM_ERROR", "Agnes AI : credit exhausted"));
    textToImageMock.mockResolvedValue(blobFrom([1, 2, 3]));
    vi.mocked(isR2Configured).mockReturnValue(false);
    const result = await generateImageWithFallback({ prompt: "un logo", userId: "u1" });
    expect(result.provider).toBe("huggingface");
    expect(result.imageUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.storagePath).toBeUndefined();
  });

  it("génération HF directe : data URI correct + timeout respecté", async () => {
    textToImageMock.mockResolvedValue(blobFrom([9, 9, 9, 9], "image/jpeg"));
    const result = await generateImageWithHuggingFace({ prompt: "un paysage", ratio: "9:16", timeoutMs: 30_000 });
    expect(result.dataUri).toMatch(/^data:image\/jpeg;base64,/);
    expect(result.model).toContain("Z-Image-Turbo");
  });
});
