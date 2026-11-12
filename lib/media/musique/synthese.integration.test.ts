import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFfmpegBinary } from "@/lib/video/security";

import { composerMusique } from "./composition";
import { parseStyleMusique } from "./styles";
import { synthetiserMusique } from "./synthese";

/**
 * INTÉGRATION FFmpeg RÉELLE (Task 2-a AUDIO) — aucun mock : la chaîne
 * composition → PCM → WAV → MP3 passe par le VRAI binaire (ffmpeg-static,
 * résolu par la même voie que le pipeline vidéo). Sert à prouver le
 * scénario propriétaire : la musique est un fichier MP3 réel et audible
 * (en-tête ID3/ MPEG), pas un faux succès. Sautée proprement si aucun
 * binaire FFmpeg n'est présent dans l'environnement de test.
 */

/** Le binaire RÉSOLU par le pipeline vidéo (ffmpeg-static si le binaire
 * existe réellement, sinon téléchargement runtime, sinon PATH) — le test
 * vérifie le MP3 avec la MÊME source de binaire que la synthèse, jamais un
 * chemin brut absent du runner (postinstall ffmpeg-static bloqué en CI). */
async function binaireVerifie(): Promise<string> {
  const resolu = await resolveFfmpegBinary();
  if (!resolu.path) throw new Error("aucun binaire FFmpeg résolvable");
  return resolu.path;
}

describe("intégration FFmpeg réelle — musique → MP3 jouable", () => {
  it("convertit une composition de 10 s en MP3 valide (ID3) avec la durée exacte", { timeout: 120_000 }, async () => {
    const ffmpeg = await binaireVerifie();

    // 1) Composition réelle (10 s — rapide, mêmes moteurs que 2 min).
    const parsee = parseStyleMusique("une musique calme de 2 minutes au piano");
    const composition = composerMusique({
      demande: "une musique calme de 2 minutes au piano",
      dureeSecondes: 10,
      style: parsee.style,
    });
    expect(composition.pcm.length).toBeGreaterThan(0);

    // 2) Synthèse RÉELLE (aucun mock) → MP3.
    const rendu = await synthetiserMusique({
      pcm: composition.pcm,
      frequence: composition.frequence,
      canaux: composition.canaux,
      titre: "Intégration gen3ia",
    });
    expect(rendu.mp3).toBe(true);
    expect(rendu.mime).toBe("audio/mpeg");
    expect(rendu.dureeSecondes).toBeCloseTo(10, 1);
    // En-tête MP3 : ID3v2 (titre écrit) ou frame MPEG sync.
    const entete = rendu.buffer.subarray(0, 3).toString("ascii");
    expect(entete === "ID3" || rendu.buffer[0] === 0xff).toBe(true);

    // 3) Vérification indépendante par FFmpeg lui-même (durée lue ≈ 10 s).
    const dir = await mkdtemp(join(tmpdir(), "gen3ia-integration-"));
    try {
      const cheminMp3 = join(dir, "verif.mp3");
      await writeFile(cheminMp3, rendu.buffer);
      const dureeLue = await new Promise<number>((accept, reject) => {
        const proc = spawn(ffmpeg, ["-i", cheminMp3, "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        proc.stderr.on("data", (c: Buffer) => {
          stderr += c.toString();
        });
        proc.on("close", () => {
          const m = /time=(\d+):(\d+):(\d+\.\d+)/u.exec(stderr);
          if (!m) reject(new Error(`durée illisible : ${stderr.slice(-300)}`));
          else accept(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
        });
        proc.on("error", reject);
      });
      expect(Math.abs(dureeLue - 10)).toBeLessThanOrEqual(0.5);
      expect(rendu.buffer.length).toBeGreaterThan(10_000); // ~10 s à 160 kbit/s
      await readFile(cheminMp3); // lisible intégralement
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
