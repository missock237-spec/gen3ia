import "server-only";

/**
 * SYNTHÈSE DE CONTENEUR AUDIO — PCM → WAV (en-tête RIFF canonique écrit à la
 * main) → MP3 via FFmpeg QUAND le binaire est disponible.
 *
 * Mission propriétaire gen3ia (Task 2-a AUDIO) : « une vraie MUSIQUE
 * générable » doit être livrée en un FICHIER JOUABLE :
 *  - l'encodage WAV est 100 % Node (aucune dépendance) : toujours possible,
 *    jouable par <audio> et les lecteurs système ;
 *  - la conversion MP3 (libmp3lame 160 kbit/s — ~2,4 Mo pour 2 min, ID3
 *    titre) passe par le bac à sable FFmpeg EXISTANT du pipeline vidéo (lib/video/ffmpeg.ts — mêmes
 *    gardes : -nostdin, protocol_whitelist file,pipe, timeout, plafond
 *    d'allocation) : détection du binaire par resolveFfmpegBinary (env →
 *    ffmpeg-static → téléchargement runtime → PATH). FFmpeg absent ou en
 *    échec → repli HONNÊTE sur le WAV (jamais de faux MP3, jamais de
 *    fichier vide) ;
 *  - la durée RÉELLE est calculée sur les échantillons PCM (exacte à
 *    l'image près) — jamais déclarée, toujours mesurée ;
 *  - GARDE ANTI-SILENCE : un PCM dont le RMS global est quasi nul jette —
 *    « jamais de silence de 2 min déguisé en musique ».
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runFfmpeg } from "@/lib/video/ffmpeg";

/** Taille minimale d'un MP3 censé contenir de la musique (garde anti-vide). */
const MP3_MIN_OCTETS = 2_000;

/** RMS minimal admis (musique composée ≈ 0.05..0.3 ; silence < 1e-4). */
const RMS_MIN = 5e-4;

export interface RenduSynthese {
  /** WAV (repli jouable) ou MP3 (FFmpeg disponible). */
  buffer: Buffer;
  mime: "audio/mpeg" | "audio/wav";
  extension: "mp3" | "wav";
  /** Moteur de conteneur réellement utilisé (transparence honnête). */
  moteur: string;
  /** Durée RÉELLE mesurée sur les échantillons PCM (exacte). */
  dureeSecondes: number;
  /** Conversion FFmpeg réussie ? (false → WAV de repli). */
  mp3: boolean;
  /** Diagnostic d'échec FFmpeg quand le repli WAV a été pris (jamais secret). */
  diagnostic?: string;
}

/** Encode PCM 16 bits entrelacé → WAV PCM (en-tête RIFF/WAVE de 44 octets). */
export function encoderWavPcm16(pcm: Buffer, frequence: number, canaux: number): Buffer {
  if (canaux !== 1 && canaux !== 2) throw new Error("WAV : nombre de canaux non géré (1 ou 2).");
  if (frequence < 8000 || frequence > 192000) throw new Error("WAV : fréquence hors bornes.");
  if (pcm.length === 0 || pcm.length % (canaux * 2) !== 0) {
    throw new Error("WAV : taille PCM incohérente avec le nombre de canaux.");
  }
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16); // taille du chunk fmt
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(canaux, 22);
  wav.writeUInt32LE(frequence, 24);
  wav.writeUInt32LE(frequence * canaux * 2, 28); // débit octets
  wav.writeUInt16LE(canaux * 2, 32); // alignement bloc
  wav.writeUInt16LE(16, 34); // bits par échantillon
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

/** RMS global d'un PCM 16 bits (détection de silence, garde honnête). */
export function rmsPcm16(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let somme = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    somme += v * v;
  }
  return Math.sqrt(somme / n);
}

/** Jette si le PCM est muet — « jamais de silence déguisé en musique ». */
export function exigerPcmNonSilencieux(pcm: Buffer): void {
  const rms = rmsPcm16(pcm);
  if (!Number.isFinite(rms) || rms < RMS_MIN) {
    throw new Error(
      `Composition muette refusée (RMS ${rms.toExponential(2)} < ${RMS_MIN}) — aucune musique ne serait audible.`,
    );
  }
}

/** Convertit un WAV en MP3 (libmp3lame) dans le bac à sable FFmpeg existant. */
async function convertirEnMp3(params: {
  wav: Buffer;
  dureeSecondes: number;
  titre?: string;
}): Promise<{ buffer: Buffer; moteur: string }> {
  const dir = await mkdtemp(join(tmpdir(), "gen3ia-musique-"));
  const entree = join(dir, "entree.wav");
  const sortie = join(dir, "sortie.mp3");
  try {
    await writeFile(entree, params.wav);
    await runFfmpeg({
      args: [
        "-i", "entree.wav",
        "-codec:a", "libmp3lame",
        "-b:a", "160k",
        "-id3v2_version", "3",
        ...(params.titre ? ["-metadata", `title=${params.titre}`] : []),
        "sortie.mp3",
      ],
      cwd: dir,
      outputDurationSec: Math.max(1, params.dureeSecondes),
      outputPaths: [sortie],
    });
    const mp3 = await readFile(sortie);
    if (mp3.length < MP3_MIN_OCTETS) {
      throw new Error(`MP3 suspectement petit (${mp3.length} octets) — repli WAV.`);
    }
    return { buffer: mp3, moteur: "ffmpeg-libmp3lame-160k" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * PCM composition → conteneur livrable : MP3 quand FFmpeg est disponible,
 * sinon WAV natif jouable. Ne jette QUE sur un contenu inlivrable (PCM
 * muet/vide, en-tête incohérent) — jamais sur un échec de conversion
 * (repli WAV honnête, signalé dans `moteur`/`mp3`/`diagnostic`).
 */
export async function synthetiserMusique(params: {
  pcm: Buffer;
  frequence: number;
  canaux: number;
  /** Titre ID3 (MP3) — utilisé aussi pour le nom de fichier côté tool. */
  titre?: string;
}): Promise<RenduSynthese> {
  exigerPcmNonSilencieux(params.pcm);
  const echantillons = Math.floor(params.pcm.length / 2 / params.canaux);
  const dureeSecondes = Math.round((echantillons / params.frequence) * 1000) / 1000;
  const wav = encoderWavPcm16(params.pcm, params.frequence, params.canaux);
  try {
    const mp3 = await convertirEnMp3({
      wav,
      dureeSecondes,
      ...(params.titre ? { titre: params.titre } : {}),
    });
    return {
      buffer: mp3.buffer,
      mime: "audio/mpeg",
      extension: "mp3",
      moteur: mp3.moteur,
      dureeSecondes,
      mp3: true,
    };
  } catch (erreur) {
    // Repli HONNÊTE : le WAV est réel, jouable, durées exactes — on le
    // livre en le DISANT (diagnostic non secret pour le note final).
    const diagnostic = erreur instanceof Error ? erreur.message.slice(0, 300) : String(erreur);
    return {
      buffer: wav,
      mime: "audio/wav",
      extension: "wav",
      moteur: "wav-pcm16-native",
      dureeSecondes,
      mp3: false,
      diagnostic,
    };
  }
}
