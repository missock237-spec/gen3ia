import { describe, expect, it } from "vitest";
import { voixChanson, decoderVoixPcm, mixerChanson, produireClipMusical, FREQUENCE_CHANSON } from "./chanson";
import { synthetiserMusique } from "./synthese";

/**
 * INTÉGRATION RÉELLE (chaîne audio complète de la chanson) : TTS humain
 * (cascade professeur → espace public Edge-TTS) → décodage FFmpeg → mixage
 * avec ducking → encodage MP3. SAUTÉE proprement si le réseau/TTS est
 * indisponible (sandbox isolé) — en production elle prouve le chemin réel.
 */
const RESEAU_DISPONIBLE = process.env.CHANSON_IT_REEL === "1";

describe.runIf(RESEAU_DISPONIBLE)("chanson — chaîne audio réelle (TTS → FFmpeg → mix → MP3)", () => {
  it("une voix réelle est produite, décodée, mixée et encodée", async () => {
    const voix = await voixChanson("La mer chante ce soir, doucement.");
    expect(voix.buffer.length).toBeGreaterThan(2000);
    expect(voix.moteur.length).toBeGreaterThan(0);

    const pcm = await decoderVoixPcm(voix.buffer, voix.mime);
    expect(pcm.length).toBeGreaterThan(FREQUENCE_CHANSON / 2); // ≥ 0,5 s réel

    const echantillons = FREQUENCE_CHANSON * 5;
    const musique = { g: new Float32Array(echantillons).fill(0.4), d: new Float32Array(echantillons).fill(0.4) };
    const mixe = mixerChanson({ musiqueGauche: musique.g, musiqueDroite: musique.d, segments: [{ debutSec: 1, pcm }], frequence: FREQUENCE_CHANSON });

    const entrelace = new Float32Array(echantillons * 2);
    for (let i = 0; i < echantillons; i += 1) {
      entrelace[2 * i] = mixe.gauche[i];
      entrelace[2 * i + 1] = mixe.droite[i];
    }
    const pcm16 = Buffer.alloc(entrelace.length * 2);
    for (let i = 0; i < entrelace.length; i += 1) {
      pcm16.writeInt16LE(Math.round(Math.max(-1, Math.min(1, entrelace[i])) * 32767), i * 2);
    }
    const rendu = await synthetiserMusique({ pcm: pcm16, frequence: FREQUENCE_CHANSON, canaux: 2, titre: "Test intégration" });
    expect(rendu.buffer.length).toBeGreaterThan(50_000);
    expect(["audio/mpeg", "audio/wav"]).toContain(rendu.mime);
  }, 120_000);

  it("le CLIP MUSICAL est rendu réel (MP4 muxé avec l'audio, plans ≥ 3)", async () => {
    // MP3 silencieux de 6 s (anullsrc) — la chaîne clip est visuelle.
    const { execFileSync } = await import("node:child_process");
    const { mkdtemp } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "clip-it-"));
    const mp3 = join(dir, "audio.mp3");
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "6", "-c:a", "libmp3lame", "-b:a", "128k", mp3], { timeout: 60_000 });
    const { readFileSync, statSync } = await import("node:fs");
    const audioMp3 = readFileSync(mp3);
    expect(statSync(mp3).size).toBeGreaterThan(10_000);

    let clip;
    try {
      clip = await produireClipMusical({ audioMp3, titre: "L'été des étoiles", dureeSec: 6, styleLabel: "pop acoustique", plans: 3 });
    } catch (erreur: unknown) {
      // Diagnostic permanent : stderr FFmpeg complet en cas d'échec.
      const stderr = (erreur as { stderr?: string })?.stderr;
      if (stderr) console.error("[clip stderr]", stderr.slice(-1500));
      throw erreur;
    }
    expect(clip.plans).toBeGreaterThanOrEqual(3);
    expect(clip.mime).toBe("video/mp4");
    expect(clip.buffer.length).toBeGreaterThan(30_000);
    // MP4 réel : magie ftyp + moov/mdat (mux FFmpeg authentique).
    const tete = clip.buffer.subarray(0, 32).toString("latin1");
    expect(tete).toContain("ftyp");
    expect(clip.buffer.subarray(4, 4096).toString("latin1") + clip.buffer.subarray(4096, 8192).toString("latin1")).toContain("moov");
  }, 180_000);
});
