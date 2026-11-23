import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import {
  appliquerEditionAudio,
  appliquerEditionImage,
  appliquerOperationsWav,
  ecrireWavPcm16,
  interpreterDemandeEdition,
  lireWavPcm16,
  operationsSupportees,
} from "./edition";

/**
 * ÉDITION D'ARTEFACTS PAR PROMPT — le parseur FR (pur) et les moteurs RÉELS
 * sont testés : sharp pour l'image (dimensions vérifiées après rotation/
 * recadrage), PCM/WAV maison pour l'audio (échantillons réellement
 * transformés), ffmpeg pour la vidéo (générée par ffmpeg lui-même, puis
 * découpée — skip honnête si ffmpeg est absent du déploiement).
 */
describe("interprétation du prompt FR (pure)", () => {
  it("image : rotation, filtres, luminosité/contraste, recadrage, redimensionnement", () => {
    const d = interpreterDemandeEdition(
      "image",
      "pivoter à gauche, puis noir et blanc, un peu de flou, luminosité +25 %, contraste +40 %, recadrer carré, puis 800x600",
    );
    const noms = d.operations.map((o) => o.nom);
    expect(noms).toEqual([
      "rotation-gauche",
      "gris",
      "flou",
      "luminosite",
      "contraste",
      "carre",
      "redimensionner",
    ]);
    expect(d.operations[3].valeur).toBe(25);
    expect(d.operations[4].valeur).toBe(40);
    expect(d.nonComprises).toHaveLength(0);
  });

  it("image : miroir et retournement distingués ; rien reconnu → refus honnête", () => {
    const d = interpreterDemandeEdition("image", "effet miroir");
    expect(d.operations[0].nom).toBe("miroir");
    const rien = interpreterDemandeEdition("image", "change le ciel en violet avec des licornes");
    expect(rien.operations).toHaveLength(0);
    expect(rien.nonComprises.length).toBeGreaterThan(0);
    expect(operationsSupportees("image")).toMatch(/rotation/);
  });

  it("audio : volume signé, vitesse (ralentir inverse), découpe, fondu, normalisation, muet", () => {
    const d = interpreterDemandeEdition(
      "audio",
      "volume -30 %, puis ralentir la vitesse 2x, couper les 4 premières secondes, garder 12 secondes, fondu 3 s, normaliser, sans son",
    );
    const noms = d.operations.map((o) => o.nom);
    expect(noms).toEqual(["volume:-30", "vitesse:0.5", "couper-debut", "garder-duree", "fondu", "normaliser", "muet"]);
    expect(d.operations[1].valeur).toBeCloseTo(0.5);
    expect(d.operations[2].valeur).toBe(4);
    expect(d.operations[3].valeur).toBe(12);
  });

  it("vidéo : découpe, vitesse, muet, échelles standard", () => {
    const d = interpreterDemandeEdition("video", "couper les 2 premières secondes, garder 15 secondes, vitesse 2x, muet, 720p");
    const noms = d.operations.map((o) => o.nom);
    expect(noms).toEqual(["couper-debut", "garder-duree", "vitesse:2", "muet", "echelle:720"]);
  });
});

/* Fabrique un WAV PCM16 mono 22050 Hz de test (1 s d'une rampe audible). */
function wavTest(dureeSecondes = 1, frequence = 22_050): Buffer {
  const n = dureeSecondes * frequence;
  const echantillons = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    echantillons[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / frequence) * 12000);
  }
  return ecrireWavPcm16({ canaux: 1, echantillonParSeconde: frequence, echantillons });
}

describe("édition AUDIO réelle (PCM/WAV)", () => {
  it("aller-retour WAV : parse → réécrit → mêmes échantillons", () => {
    const source = wavTest(0.5);
    const wav = lireWavPcm16(source);
    expect(wav.canaux).toBe(1);
    expect(wav.echantillonParSeconde).toBe(22_050);
    expect(wav.echantillons.length).toBe(11_025);
    const reecrit = lireWavPcm16(ecrireWavPcm16({ canaux: wav.canaux, echantillonParSeconde: wav.echantillonParSeconde, echantillons: wav.echantillons }));
    expect(Array.from(reecrit.echantillons)).toEqual(Array.from(wav.echantillons));
  });

  it("volume : échantillons réellement modifiés (facteur mesuré)", () => {
    const wav = lireWavPcm16(wavTest(0.5));
    const { wav: fort } = appliquerOperationsWav(wav, [{ nom: "volume:50", libelle: "Volume +50 %", valeur: 50 }]);
    const crêteAvant = Math.max(...Array.from(wav.echantillons).map(Math.abs));
    const crêteApres = Math.max(...Array.from(fort.echantillons).map(Math.abs));
    expect(crêteApres).toBeGreaterThan(crêteAvant * 1.4);
    const { wav: faible } = appliquerOperationsWav(wav, [{ nom: "volume:-50", libelle: "Volume −50 %", valeur: -50 }]);
    const crêteFaible = Math.max(...Array.from(faible.echantillons).map(Math.abs));
    expect(crêteFaible).toBeLessThan(crêteAvant * 0.6);
  });

  it("découpe et durée : couper-debut + garder-duree raccourcissent réellement", () => {
    const wav = lireWavPcm16(wavTest(2));
    const { wav: coupe } = appliquerOperationsWav(wav, [
      { nom: "couper-debut", libelle: "1 s coupée", valeur: 1 },
      { nom: "garder-duree", libelle: "0.5 s gardée", valeur: 0.5 },
    ]);
    expect(coupe.echantillons.length).toBe(Math.round(0.5 * 22_050));
  });

  it("muet : silence total ; normalisation : crête ramenée vers le max", () => {
    const wav = lireWavPcm16(wavTest(0.3));
    const { wav: silencieux } = appliquerOperationsWav(wav, [{ nom: "muet", libelle: "Muet" }]);
    expect(Array.from(silencieux.echantillons).every((v) => v === 0)).toBe(true);
    const discret = new Int16Array(wav.echantillons.length);
    for (let i = 0; i < discret.length; i += 1) discret[i] = Math.round(wav.echantillons[i] * 0.2);
    const { wav: normalise } = appliquerOperationsWav({ ...wav, echantillons: discret }, [
      { nom: "normaliser", libelle: "Normalisation" },
    ]);
    const crête = Math.max(...Array.from(normalise.echantillons).map(Math.abs));
    expect(crête).toBeGreaterThan(29_000); // ≈ 32767 × 0.95
  });

  it("pipeline audio complet : prompt → WAV édité (durée et volume réels)", async () => {
    const demande = interpreterDemandeEdition("audio", "volume +100 %, garder 1 seconde");
    const edite = await appliquerEditionAudio(wavTest(2), demande.operations);
    const wav = lireWavPcm16(edite);
    expect(wav.echantillons.length).toBe(22_050);
    const crêteAvant = Math.max(...Array.from(lireWavPcm16(wavTest(2)).echantillons).map(Math.abs));
    const crêteApres = Math.max(...Array.from(wav.echantillons).map(Math.abs));
    expect(crêteApres).toBeGreaterThan(Math.min(32_000, crêteAvant * 1.8));
  });

  it("WAV non PCM16 : refus honnête (pas de transformation inventée)", () => {
    const faux = Buffer.from("ceci n'est pas un wav du tout", "utf-8");
    expect(() => lireWavPcm16(faux)).toThrow(/RIFF\/WAVE attendu/);
  });
});

describe("édition IMAGE réelle (sharp)", () => {
  /** PNG de test 64×32 : généré par sharp lui-même (aucune fixture binaire). */
  async function pngTest(): Promise<Buffer> {
    const { default: sharp } = await import("sharp");
    return sharp({
      create: { width: 64, height: 32, channels: 3, background: { r: 120, g: 60, b: 200 } },
    })
      .png()
      .toBuffer();
  }

  it("rotation : dimensions réellement échangées (64×32 → 32×64)", async () => {
    const { default: sharp } = await import("sharp");
    const demande = interpreterDemandeEdition("image", "pivoter à droite");
    const edite = await appliquerEditionImage(await pngTest(), demande.operations);
    const meta = await sharp(edite).metadata();
    expect(meta.width).toBe(32);
    expect(meta.height).toBe(64);
  });

  it("recadrage carré + redimensionnement + noir et blanc appliqués", async () => {
    const { default: sharp } = await import("sharp");
    const demande = interpreterDemandeEdition("image", "recadrer carré, puis 48x24, noir et blanc");
    const edite = await appliquerEditionImage(await pngTest(), demande.operations);
    const meta = await sharp(edite).metadata();
    expect(meta.width).toBe(48);
    expect(meta.height).toBe(24);
    const stats = await sharp(edite).stats();
    // En N&B pur, les trois canaux partagent exactement la même distribution.
    expect(stats.channels[0].mean).toBeCloseTo(stats.channels[2].mean, 6);
  });
});

describe("édition VIDÉO réelle (ffmpeg — skip honnête si absent)", () => {
  it("découpe réelle d'une vidéo générée par ffmpeg (couper le début)", async () => {
    const { checkFfmpegAvailable } = await import("@/lib/video/ffmpeg");
    const dispo = await checkFfmpegAvailable();
    if (!dispo.ffmpeg || !dispo.ffprobe) {
      // Déploiement sans ffmpeg : le REFUS honnête est le comportement attendu.
      const { appliquerEditionVideo } = await import("./edition");
      await expect(
        appliquerEditionVideo(Buffer.from("x"), [{ nom: "couper-debut", libelle: "1 s", valeur: 1 }], "mp4"),
      ).rejects.toThrow(/ffmpeg\/ffprobe absents/);
      return;
    }
    const { runFfmpeg, probeMedia } = await import("@/lib/video/ffmpeg");
    const { appliquerEditionVideo } = await import("./edition");
    const bac = mkdtempSync(join(tmpdir(), "g3v-test-"));
    try {
      // Vidéo source : 4 s de couleur unie (ffmpeg génère lui-même la fixture).
      const source = join(bac, "source.mp4");
      await runFfmpeg({
        args: ["-f", "lavfi", "-i", "color=c=blue:size=320x240:rate=15:duration=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", source],
        cwd: bac,
        outputDurationSec: 4,
        outputPaths: [source],
      });
      const tailleSource = (await readFile(source)).length;
      const probeSource = await probeMedia(source, bac);
      expect(tailleSource).toBeGreaterThan(500);
      expect(probeSource.durationSec).toBeGreaterThan(3.5);
      const sourceBuffer = await readFile(source);
      const demande = interpreterDemandeEdition("video", "couper les 3 premières secondes");
      const edite = await appliquerEditionVideo(sourceBuffer, demande.operations, "mp4");
      const editePath = join(bac, `edite-${randomUUID()}.mp4`);
      await writeFile(editePath, edite);
      const probeEdite = await probeMedia(editePath, bac);
      expect(probeEdite.durationSec).toBeLessThan(1.5); // 4 − 3 = 1 s
      expect(edite.length).toBeGreaterThan(1000);
    } finally {
      await rm(bac, { recursive: true, force: true });
    }
  }, 60_000);
});
