import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests du module d'analyse média (image / audio / vidéo) :
 *  - dispatcher par type MIME (image → vision, audio → Scribe, vidéo → FFmpeg) ;
 *  - échecs HONNÊTES (format non supporté, absence de parole, source refusée) ;
 *  - connexion conversation (fail-soft, plafond 2 médias, sécurité préfixe R2).
 */

const { generateMock, transcribeMock, probeMock, runFfmpegMock, cleanupMock, downloadMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  transcribeMock: vi.fn(),
  probeMock: vi.fn(),
  runFfmpegMock: vi.fn(),
  cleanupMock: vi.fn(),
  downloadMock: vi.fn(),
}));

vi.mock("@/lib/ai/router", () => ({
  generate: generateMock,
}));

vi.mock("@/lib/knowledge/perception", () => ({
  transcribeAudioToText: transcribeMock,
}));

vi.mock("@/lib/video/ffmpeg", () => ({
  probeMedia: probeMock,
  runFfmpeg: runFfmpegMock,
  cleanupTmpDir: cleanupMock,
}));

vi.mock("@/lib/storage/r2", () => ({
  downloadFromR2: downloadMock,
}));

import {
  analyzeAttachedMediaContext,
  analyzeAudioContent,
  analyzeImageContent,
  analyzeMediaContent,
  analyzeVideoContent,
  loadMediaSource,
} from "./analysis";

// Le mock FFmpeg « écrit » réellement les sorties attendues (frames + audio).
runFfmpegMock.mockImplementation(async (params: { args: string[]; cwd: string }) => {
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const output = params.args[params.args.length - 1];
  await writeFile(join(params.cwd, output), Buffer.from("media-bytes"));
  return { stdout: "", stderr: "" };
});

beforeEach(() => {
  generateMock.mockReset().mockResolvedValue({ text: "Analyse factuelle du média." });
  transcribeMock.mockReset().mockResolvedValue({ text: "Bonjour et bienvenue sur Gen3ia.", providerLabel: "scribe_v1:fr" });
  probeMock.mockReset().mockResolvedValue({ durationSec: 12, width: 640, height: 360, fps: 25, hasAudio: true, audioCodec: "aac", videoCodec: "h264" });
  runFfmpegMock.mockClear();
  cleanupMock.mockClear();
  downloadMock.mockReset().mockResolvedValue(Buffer.from("audio-bytes"));
});

describe("analyse image (vision)", () => {
  it("envoie l'image au modèle vision avec la question", async () => {
    const result = await analyzeImageContent({ buffer: Buffer.from("img"), mimeType: "image/png", question: "Que voit-on ?" });
    expect(result.providerLabel).toBe("vision");
    expect(result.analysis).toContain("Analyse factuelle");
    const call = generateMock.mock.calls[0][0] as { messages: Array<{ content: string; images?: unknown[] }> };
    expect(call.messages[1].content).toContain("Que voit-on ?");
    expect(call.messages[1].images).toHaveLength(1);
  });

  it("refuse honnêtement un format non vision", async () => {
    await expect(analyzeImageContent({ buffer: Buffer.from("x"), mimeType: "image/svg+xml" })).rejects.toThrow(/format non pris en charge/i);
    expect(generateMock).not.toHaveBeenCalled();
  });
});

describe("analyse audio (Scribe + LLM)", () => {
  it("transcrit puis synthétise (transcript inclus)", async () => {
    const result = await analyzeAudioContent({ buffer: Buffer.from("a"), filename: "note.mp3", mimeType: "audio/mpeg", question: "De quoi parle-t-on ?" });
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    expect(result.analysis).toContain("Bonjour et bienvenue");
    const call = generateMock.mock.calls[0][0] as { messages: Array<{ content: string }> };
    expect(call.messages[1].content).toContain("De quoi parle-t-on ?");
  });

  it("échec honnête quand aucune parole n'est détectée", async () => {
    transcribeMock.mockResolvedValue({ text: "", providerLabel: "scribe_v1" });
    await expect(analyzeAudioContent({ buffer: Buffer.from("a"), filename: "silence.mp3" })).rejects.toThrow(/aucune parole détectée/i);
    expect(generateMock).not.toHaveBeenCalled();
  });
});

describe("analyse vidéo (FFmpeg + Scribe + vision)", () => {
  it("extrait les frames + la piste audio, puis UNE analyse vision enrichie", async () => {
    const result = await analyzeVideoContent({ buffer: Buffer.from("video"), filename: "clip.mp4", question: "Résume cette vidéo." });
    expect(result.kind).toBe("video");
    expect(result.metadata?.durationSec).toBe(12);
    // durée 12 s → 2 frames réparties + 1 extraction audio.
    expect(runFfmpegMock).toHaveBeenCalledTimes(3);
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    expect(cleanupMock).toHaveBeenCalled();
    const call = generateMock.mock.calls[0][0] as { messages: Array<{ content: string; images?: unknown[] }> };
    expect(call.messages[1].content).toContain("Résume cette vidéo.");
    expect(call.messages[1].content).toContain("Bonjour et bienvenue");
    expect(call.messages[1].images).toHaveLength(2);
    expect(result.providerLabel).toContain("scribe_v1");
  });

  it("vidéo sans audio : analyse vision seule (aucune transcription)", async () => {
    probeMock.mockResolvedValue({ durationSec: 4, width: 640, height: 360, fps: 24, hasAudio: false });
    const result = await analyzeVideoContent({ buffer: Buffer.from("video"), filename: "muet.mp4" });
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(result.providerLabel).not.toContain("scribe_v1");
  });
});

describe("dispatcher analyzeMediaContent", () => {
  it("route par type MIME", async () => {
    const image = await analyzeMediaContent({ buffer: Buffer.from("i"), mimeType: "image/png", filename: "a.png" });
    expect(image.kind).toBe("image");
    const audio = await analyzeMediaContent({ buffer: Buffer.from("a"), mimeType: "audio/mpeg", filename: "a.mp3" });
    expect(audio.kind).toBe("audio");
    const video = await analyzeMediaContent({ buffer: Buffer.from("v"), mimeType: "video/mp4", filename: "a.mp4" });
    expect(video.kind).toBe("video");
  });

  it("type inconnu → erreur explicite", async () => {
    await expect(analyzeMediaContent({ buffer: Buffer.from("z"), mimeType: "application/zip", filename: "a.zip" })).rejects.toThrow(/non analysable/i);
  });
});

describe("loadMediaSource (sécurité)", () => {
  it("clé R2 du propriétaire acceptée", async () => {
    const source = await loadMediaSource({ userId: "u1", path: "users/u1/permanent/note.mp3" });
    expect(source.mimeType).toBe("audio/mpeg");
    expect(downloadMock).toHaveBeenCalledWith("users/u1/permanent/note.mp3");
  });

  it("clé R2 d'un AUTRE utilisateur → refus", async () => {
    await expect(loadMediaSource({ userId: "u1", path: "users/other/permanent/note.mp3" })).rejects.toThrow(/Accès refusé/);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("URL https acceptée, autre schéma refusé", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(Buffer.from("bytes"), { status: 200, headers: { "content-type": "audio/mpeg" } })) as unknown as typeof fetch;
    const source = await loadMediaSource({ userId: "u1", url: "https://cdn.example/note.mp3", fallbackFilename: "note.mp3" });
    expect(source.mimeType).toBe("audio/mpeg");
    await expect(loadMediaSource({ userId: "u1", url: "http://insecure.example/n.mp3" })).rejects.toThrow(/Aucune source/);
  });
});

describe("connexion conversation : analyzeAttachedMediaContext", () => {
  it("analyse le média audio joint et retourne un bloc de contexte", async () => {
    const context = await analyzeAttachedMediaContext(
      "u1",
      [{ filename: "note.mp3", contentType: "audio/mpeg", path: "users/u1/permanent/note.mp3" }],
      "De quoi parle cet audio ?",
    );
    expect(context).toContain("ANALYSE RÉELLE des médias joints");
    expect(context).toContain("note.mp3");
    // La question utilisateur a bien été transmise à l'analyse.
    const call = generateMock.mock.calls[0][0] as { messages: Array<{ content: string }> };
    expect(call.messages[1].content).toContain("De quoi parle cet audio ?");
  });

  it("fail-soft : échec d'analyse → note, JAMAIS d'exception", async () => {
    transcribeMock.mockRejectedValue(new Error("ELEVENLABS_API_KEY n'est pas configurée."));
    const context = await analyzeAttachedMediaContext(
      "u1",
      [{ filename: "note.mp3", contentType: "audio/mpeg", path: "users/u1/permanent/note.mp3" }],
      "analyse",
    );
    expect(context).toContain("analyse indisponible");
  });

  it("aucun média audio/vidéo → chaîne vide (images = voie vision native)", async () => {
    const context = await analyzeAttachedMediaContext("u1", [{ filename: "photo.png", contentType: "image/png", url: "https://x/y.png" }], "hello");
    expect(context).toBe("");
  });

  it("plafond : 2 médias maximum par tour", async () => {
    const attachments = [1, 2, 3].map((n) => ({ filename: `n${n}.mp3`, contentType: "audio/mpeg", path: `users/u1/permanent/n${n}.mp3` }));
    await analyzeAttachedMediaContext("u1", attachments, "analyse");
    expect(downloadMock).toHaveBeenCalledTimes(2);
  });
});
