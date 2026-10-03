import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * COUCHE DE PERCEPTION (concept #9 « Reality-to-Digital Engine ») :
 * acheminement OCR/ASR pur, OCR réel via le routeur vision (pièce jointe
 * base64 validée), ASR ElevenLabs Scribe réel (multipart), échecs honnêtes
 * (fournisseur absent, format/taille refusés), jamais de texte inventé.
 */

const generateMock = vi.fn();
vi.mock("@/lib/ai/router", () => ({
  generate: (...args: unknown[]) => generateMock(...args),
}));

import {
  ocrImageToText,
  perceptionRouteFor,
  PERCEPTION_MAX_AUDIO_BYTES,
  transcribeAudioToText,
} from "./perception";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  generateMock.mockReset();
  fetchMock.mockReset();
  delete process.env.ELEVENLABS_API_KEY;
});

describe("acheminement perception (pur)", () => {
  it("images → OCR, audios → ASR, textes → null", () => {
    expect(perceptionRouteFor("image/png", "scan.png")).toBe("ocr");
    expect(perceptionRouteFor("", "photo.JPG")).toBe("ocr");
    expect(perceptionRouteFor("audio/mpeg", "memo.mp3")).toBe("asr");
    expect(perceptionRouteFor("", "note.txt")).toBeNull();
    expect(perceptionRouteFor("application/pdf", "doc.pdf")).toBeNull();
  });
});

describe("OCR (modèle vision du routeur)", () => {
  it("transcription réelle : pièce jointe base64 + transcription renvoyée", async () => {
    generateMock.mockResolvedValue({ text: "FACTURE N° 2026-041\nTotal : 1 200 EUR" });
    const { text, providerLabel } = await ocrImageToText({ buffer: Buffer.from("png-bytes"), mimeType: "image/png", filename: "facture.png" });
    expect(text).toContain("FACTURE N° 2026-041");
    expect(providerLabel).toBe("vision-ocr");
    const request = generateMock.mock.calls[0][0];
    expect(request.requiresVision).toBe(true);
    expect(request.messages[1].images[0].source.type).toBe("base64");
    expect(request.messages[0].content).toContain("OCR");
  });

  it("image sans texte → texte vide signalé honnêtement (jamais d'invention)", async () => {
    generateMock.mockResolvedValue({ text: "[aucun texte détecté]" });
    const { text } = await ocrImageToText({ buffer: Buffer.from("x"), mimeType: "image/jpeg" });
    expect(text).toBe("");
  });

  it("format non image et taille excessive → refus SANS appel", async () => {
    await expect(ocrImageToText({ buffer: Buffer.from("x"), mimeType: "application/pdf" })).rejects.toThrow("non pris en charge");
    await expect(ocrImageToText({ buffer: Buffer.alloc(9_000_000), mimeType: "image/png" })).rejects.toThrow("trop volumineuse");
    expect(generateMock).not.toHaveBeenCalled();
  });
});

describe("ASR (ElevenLabs Scribe)", () => {
  it("transcription réelle via multipart + texte renvoyé", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: "Bonjour, merci pour votre appel.", language_code: "fra" }),
    });
    const { text, providerLabel } = await transcribeAudioToText({ buffer: Buffer.from("audio-bytes"), filename: "appel.mp3", mimeType: "audio/mpeg" });
    expect(text).toContain("Bonjour");
    expect(providerLabel).toBe("scribe_v1:fra");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init.headers["xi-api-key"]).toBe("test-key");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("clé absente → erreur qui NOMME la variable (honnêteté opérationnelle)", async () => {
    await expect(transcribeAudioToText({ buffer: Buffer.from("x"), filename: "a.mp3" })).rejects.toThrow("ELEVENLABS_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("audio trop volumineux → refus SANS appel réseau", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    await expect(transcribeAudioToText({ buffer: Buffer.alloc(PERCEPTION_MAX_AUDIO_BYTES + 1), filename: "a.mp3" })).rejects.toThrow("trop volumineux");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("échec fournisseur → erreur explicite (jamais de transcription vide masquée)", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => "overloaded" });
    await expect(transcribeAudioToText({ buffer: Buffer.from("x"), filename: "a.mp3" })).rejects.toThrow("503");
  });
});
