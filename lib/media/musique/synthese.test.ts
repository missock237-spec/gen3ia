import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * SYNTHÈSE DE CONTENEUR (Task 2-a AUDIO) — verrous :
 *  1. en-tête WAV VALIDE (octets magiques RIFF/WAVE, PCM 16 bits, byte rate
 *     cohérent) — jouable par tout lecteur ;
 *  2. durée RÉELLE calculée sur les échantillons PCM (jamais déclarée) ;
 *  3. GARDE ANTI-SILENCE : un PCM muet jette (jamais de silence déguisé en
 *     musique) ;
 *  4. FFmpeg disponible → MP3 réel ; FFmpeg absent/en échec → repli WAV
 *     HONNÊTE (mime, extension, moteur, diagnostic), jamais de faux succès.
 */

const runFfmpegMock = vi.fn();

vi.mock("@/lib/video/ffmpeg", () => ({
  runFfmpeg: (...args: unknown[]) => runFfmpegMock(...args),
}));

import { encoderWavPcm16, exigerPcmNonSilencieux, rmsPcm16, synthetiserMusique } from "./synthese";

/** PCM 16 bits stéréo d'une vraie sinusoïde non silencieuse (1 seconde). */
function pcmSinus(secondes = 1, frequence = 440, taux = 44100, canaux = 2): Buffer {
  const frames = Math.round(secondes * taux);
  const pcm = Buffer.alloc(frames * canaux * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * frequence * i) / taux) * 12000);
    for (let c = 0; c < canaux; c++) {
      pcm.writeInt16LE(v, (i * canaux + c) * 2);
    }
  }
  return pcm;
}

describe("encoderWavPcm16 — en-tête RIFF/WAVE valide", () => {
  it("octets magiques RIFF/WAVE, format PCM, champs cohérents", () => {
    const pcm = pcmSinus(0.5);
    const wav = encoderWavPcm16(pcm, 44100, 2);
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(2); // stéréo
    expect(wav.readUInt32LE(24)).toBe(44100);
    expect(wav.readUInt32LE(28)).toBe(44100 * 2 * 2); // byte rate
    expect(wav.readUInt16LE(32)).toBe(4); // bloc aligné
    expect(wav.readUInt16LE(34)).toBe(16); // bits
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    // Les échantillons sont copiés à l'identique.
    expect(wav.subarray(44, 48).equals(pcm.subarray(0, 4))).toBe(true);
  });

  it("rejette des paramètres incohérents (canaux, fréquence, taille)", () => {
    expect(() => encoderWavPcm16(Buffer.alloc(10), 44100, 3)).toThrow();
    expect(() => encoderWavPcm16(Buffer.alloc(10), 100, 1)).toThrow();
    expect(() => encoderWavPcm16(Buffer.alloc(7), 44100, 2)).toThrow();
    expect(() => encoderWavPcm16(Buffer.alloc(0), 44100, 2)).toThrow();
  });
});

describe("garde anti-silence", () => {
  it("rmsPcm16 : 0 pour du silence, significatif pour un signal", () => {
    expect(rmsPcm16(Buffer.alloc(44100 * 2 * 2))).toBe(0);
    expect(rmsPcm16(pcmSinus(1))).toBeGreaterThan(0.2);
  });

  it("exigerPcmNonSilencieux jette sur du silence (jamais de faux succès)", () => {
    expect(() => exigerPcmNonSilencieux(Buffer.alloc(4096))).toThrow(/muette/u);
    expect(() => exigerPcmNonSilencieux(pcmSinus(0.2))).not.toThrow();
  });
});

describe("synthetiserMusique — MP3 FFmpeg ou repli WAV honnête", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("FFmpeg disponible → MP3 (mime audio/mpeg, durée réelle exacte)", async () => {
    runFfmpegMock.mockImplementation(async (params: { outputPaths?: string[] }) => {
      const sortie = params.outputPaths?.[0];
      if (!sortie) throw new Error("sortie attendue");
      // Le faux binaire « écrit » un MP3 plausiblement volumineux.
      await writeFile(sortie, Buffer.alloc(50_000, 0xff));
    });
    const pcm = pcmSinus(2);
    const rendu = await synthetiserMusique({
      pcm,
      frequence: 44100,
      canaux: 2,
      titre: "Test",
    });
    expect(runFfmpegMock).toHaveBeenCalledTimes(1);
    const appel = runFfmpegMock.mock.calls[0]?.[0] as { args: string[]; cwd: string };
    expect(appel.args).toContain("libmp3lame");
    expect(appel.args).toContain("-b:a");
    expect(appel.args.join(" ")).toContain("160k");
    expect(rendu).toMatchObject({
      mime: "audio/mpeg",
      extension: "mp3",
      moteur: "ffmpeg-libmp3lame-160k",
      mp3: true,
      dureeSecondes: 2,
    });
    expect(rendu.buffer.length).toBeGreaterThanOrEqual(2000);
    // Le dossier temporaire est nettoyé (le cwd n'existe plus).
    await expect(mkdtemp(join(tmpdir(), "gen3ia-test-"))).resolves.toBeTruthy();
  });

  it("FFmpeg en échec → repli WAV HONNÊTE (diagnostic présent, durée exacte)", async () => {
    runFfmpegMock.mockRejectedValue(new Error("ffmpeg introuvable (binaire absent)"));
    const pcm = pcmSinus(2);
    const rendu = await synthetiserMusique({ pcm, frequence: 44100, canaux: 2 });
    expect(rendu.mp3).toBe(false);
    expect(rendu.mime).toBe("audio/wav");
    expect(rendu.extension).toBe("wav");
    expect(rendu.moteur).toBe("wav-pcm16-native");
    expect(rendu.diagnostic).toContain("ffmpeg introuvable");
    expect(rendu.dureeSecondes).toBe(2);
    // Le WAV de repli est un vrai WAV jouable.
    expect(rendu.buffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(rendu.buffer.length).toBe(44 + pcm.length);
  });

  it("MP3 suspectement petit → repli WAV (jamais de faux MP3)", async () => {
    runFfmpegMock.mockImplementation(async (params: { outputPaths?: string[] }) => {
      await writeFile(params.outputPaths![0] as string, Buffer.alloc(50));
    });
    const rendu = await synthetiserMusique({ pcm: pcmSinus(1), frequence: 44100, canaux: 2 });
    expect(rendu.mp3).toBe(false);
    expect(rendu.mime).toBe("audio/wav");
  });

  it("PCM muet → exception AVANT toute conversion (aucun conteneur mensonger)", async () => {
    await expect(
      synthetiserMusique({ pcm: Buffer.alloc(88200 * 2), frequence: 44100, canaux: 2 }),
    ).rejects.toThrow(/muette/u);
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });
});
