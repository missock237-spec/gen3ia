import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests comportementaux de persistGeneratedImage (Task 103-a — persistance
 * des images générées par l'outil agent).
 *
 * Verrous :
 *  1. copie R2 sous users/<uid>/permanent/ai-images/ (parité chat) avec URL
 *     signée + handle durable storagePath ;
 *  2. dégradation gracieuse JAMAIS throw : tout échec (réseau, HTTP, taille,
 *     R2 non configuré, source invalide) → storage:"provider" + URL d'origine
 *     — une génération réussie ne doit jamais être perdue pour un incident
 *     d'archivage ;
 *  3. data URI Base64 accepté (décodage direct, sans téléchargement) ;
 *  4. préfixe de sous-dossier nettoyé (aucune traversée de chemin possible).
 */

const uploadToR2Mock = vi.fn();
const createR2DownloadUrlMock = vi.fn();
const isR2ConfiguredMock = vi.fn();

vi.mock("@/lib/storage/r2", () => ({
  uploadToR2: (...args: unknown[]) => uploadToR2Mock(...args),
  createR2DownloadUrl: (...args: unknown[]) => createR2DownloadUrlMock(...args),
  isR2Configured: () => isR2ConfiguredMock(),
}));

import { persistGeneratedImage } from "./persist";

const AGNES_URL = "https://cdn.agnes.exemple.com/tmp/expiring-image.png";
const SIGNED_URL = "https://r2.exemple.com/signed/permanent-image.png";

/** Réponse http factice d'un CDN provider (octets d'image). */
function providerResponse(
  bytes: Buffer,
  contentType = "image/png",
  ok = true,
): Response {
  return new Response(ok ? bytes : "ko", {
    status: ok ? 200 : 500,
    headers: { "content-type": contentType },
  });
}

describe("persistGeneratedImage — copie R2 permanente", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isR2ConfiguredMock.mockReturnValue(true);
    uploadToR2Mock.mockResolvedValue(undefined);
    createR2DownloadUrlMock.mockResolvedValue(SIGNED_URL);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("télécharge l'URL provider, copie en R2 permanent et retourne { url signée, storage: 'r2', storagePath }", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      providerResponse(Buffer.from("png-bytes"), "image/png"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await persistGeneratedImage({
      userId: "user-1",
      imageUrl: AGNES_URL,
    });

    // Le chemin permanent standard (parité chat : engine.ts).
    expect(uploadToR2Mock).toHaveBeenCalledTimes(1);
    const [key, body, contentType] = uploadToR2Mock.mock.calls[0] as [
      string,
      Buffer,
      string,
    ];
    expect(key).toMatch(/^users\/user-1\/permanent\/ai-images\/\d+-[0-9a-f-]+\.png$/);
    expect(key).not.toContain("..");
    expect(body.toString("utf8")).toBe("png-bytes");
    expect(contentType).toBe("image/png");

    expect(createR2DownloadUrlMock).toHaveBeenCalledWith(key, 3600);
    expect(result).toEqual({
      url: SIGNED_URL,
      storage: "r2",
      storagePath: key,
    });
  });

  it("décode un data URI Base64 SANS téléchargement et copie en R2 (extension déduite du MIME)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const payload = Buffer.from("jpeg-bytes").toString("base64");

    const result = await persistGeneratedImage({
      userId: "user-1",
      imageUrl: `data:image/jpeg;base64,${payload}`,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const [key, , contentType] = uploadToR2Mock.mock.calls[0] as [
      string,
      Buffer,
      string,
    ];
    expect(key).toMatch(/^users\/user-1\/permanent\/ai-images\/\d+-[0-9a-f-]+\.jpg$/);
    expect(contentType).toBe("image/jpeg");
    expect(result.storage).toBe("r2");
    expect(result.url).toBe(SIGNED_URL);
  });

  it("honore un prefix personnalisé nettoyé — aucune traversée de chemin possible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(providerResponse(Buffer.from("png"))),
    );

    await persistGeneratedImage({
      userId: "user-1",
      imageUrl: AGNES_URL,
      prefix: "../Evil/../Portraits!",
    });

    const [key] = uploadToR2Mock.mock.calls[0] as [string];
    expect(key).toMatch(/^users\/user-1\/permanent\/evil-portraits\/\d+-[0-9a-f-]+\.png$/);
    expect(key).not.toContain("..");
  });
});

describe("persistGeneratedImage — dégradation gracieuse (jamais throw)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isR2ConfiguredMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("HTTP provider en échec → { url: originale, storage: 'provider' }, aucun upload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(providerResponse(Buffer.alloc(0), "image/png", false)),
    );

    const result = await persistGeneratedImage({
      userId: "user-1",
      imageUrl: AGNES_URL,
    });

    expect(result).toEqual({ url: AGNES_URL, storage: "provider" });
    expect(uploadToR2Mock).not.toHaveBeenCalled();
  });

  it("réseau indisponible (fetch jette) → repli provider, aucune exception", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network unreachable")),
    );

    const result = await persistGeneratedImage({
      userId: "user-1",
      imageUrl: AGNES_URL,
    });

    expect(result).toEqual({ url: AGNES_URL, storage: "provider" });
    expect(uploadToR2Mock).not.toHaveBeenCalled();
  });

  it("R2 non configuré → repli provider immédiat, sans télécharger l'image", async () => {
    isR2ConfiguredMock.mockReturnValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await persistGeneratedImage({
      userId: "user-1",
      imageUrl: AGNES_URL,
    });

    expect(result).toEqual({ url: AGNES_URL, storage: "provider" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("image au-delà de la limite de taille → repli provider (objet aberrant non persisté)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(providerResponse(Buffer.alloc(15 * 1024 * 1024 + 1, 1))),
    );

    const result = await persistGeneratedImage({
      userId: "user-1",
      imageUrl: AGNES_URL,
    });

    expect(result).toEqual({ url: AGNES_URL, storage: "provider" });
    expect(uploadToR2Mock).not.toHaveBeenCalled();
  });

  it("userId absent ou source non http/data → repli provider sans lever", async () => {
    vi.stubGlobal("fetch", vi.fn());

    expect(
      await persistGeneratedImage({ userId: "", imageUrl: AGNES_URL }),
    ).toEqual({ url: AGNES_URL, storage: "provider" });
    expect(
      await persistGeneratedImage({ userId: "user-1", imageUrl: "ftp://non.géré" }),
    ).toEqual({ url: "ftp://non.géré", storage: "provider" });
    expect(uploadToR2Mock).not.toHaveBeenCalled();
  });

  it("échec de l'upload R2 lui-même → repli provider, aucune exception", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(providerResponse(Buffer.from("png"))),
    );
    uploadToR2Mock.mockRejectedValue(new Error("R2 indisponible"));

    const result = await persistGeneratedImage({
      userId: "user-1",
      imageUrl: AGNES_URL,
    });

    expect(result).toEqual({ url: AGNES_URL, storage: "provider" });
  });
});
