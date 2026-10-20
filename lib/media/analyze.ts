import "server-only";

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  downloadFromR2,
  isR2Configured,
} from "@/lib/storage/r2";
import { isOwnedPermanentKey } from "@/lib/files/import";
import { probeMedia, runFfmpeg, cleanupTmpDir } from "@/lib/video/ffmpeg";
import { VIDEO_LIMITS } from "@/lib/video/security";
import type { MessageAttachment } from "@/lib/domain/conversations/types";

/**
 * ANALYSE MÉDIA LOCALE — lecture RÉELLE des images, audios et vidéos
 * fournis par l'utilisateur, sans aucune IA externe (moteur 100 % local,
 * déterministe et honnête).
 *
 * Ce que le moteur PERÇOIT vraiment :
 *  - IMAGE  (sharp)  : format, dimensions, orientation, palette dominante,
 *    luminosité moyenne, contraste (écart-type), entropie (richesse de
 *    détails), opacité ;
 *  - AUDIO  (ffprobe + ffmpeg volumedetect) : durée, codec, canaux,
 *    fréquence d'échantillonnage, débit moyen, volume moyen et crêtes ;
 *  - VIDÉO  (ffprobe + extraction d'images clés + sharp) : durée,
 *    dimensions, image/s, codecs, et analyse visuelle de 3 instants
 *    (palette + luminance) qui décrivent l'évolution de la scène.
 *
 * HONNÊTETÉ (invariant du projet) : le moteur ne PRÉTEND jamais percevoir
 * au-delà — la transcription vocale parlée n'est PAS incluse (aucun modèle
 * ASR local), le résumé le dit explicitement quand c'est pertinent.
 * Chaque analyse reflète des mesures réelles du fichier, jamais une
 * invention.
 */

/** Plafond par média analysé (parité politique pièces jointes : 50 Mo). */
const MAX_ANALYSE_OCTETS = VIDEO_LIMITS.maxMediaBytes;

/** Durée max de récupération d'une source distante. */
const FETCH_TIMEOUT_MS = 20_000;

/** Images clés extraites d'une vidéo (instants 10 % / 50 % / 90 %). */
const FRAMES_PAR_VIDEO = 3;

export interface AnalyseMediaLocale {
  kind: "image" | "audio" | "video";
  mime: string;
  tailleOctets: number;
  /** Résumé déterministe en français, injectable tel quel dans le chat. */
  resume: string;
  /** Mesures brutes structurées (traçabilité, outillage, tests). */
  details: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Détection de type par magic bytes (audio/vidéo/images)              */
/* ------------------------------------------------------------------ */

export function snifferContentTypeMedia(buffer: Buffer, fallback: string): string {
  if (buffer.length < 12) return (fallback || "application/octet-stream").split(";")[0].trim().toLowerCase();
  const b = buffer;
  const ascii = (start: number, len: number) => b.subarray(start, start + len).toString("latin1");

  // Images (même détection que lib/files/image-source).
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(0, 3) === "GIF") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";

  // Audio.
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";
  if (ascii(0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 4) === "fLaC") return "audio/flac";
  if (ascii(4, 4) === "ftyp" && (ascii(8, 4) === "M4A " || ascii(8, 4) === "M4B " || ascii(8, 4) === "isom" || ascii(8, 4) === "mp42")) {
    // Conteneur MP4 : audio pur (M4A) ou vidéo — tranché par ffprobe.
    return ascii(8, 4) === "M4A " ? "audio/mp4" : "video/mp4";
  }

  // Vidéo.
  if (ascii(4, 4) === "ftyp") return "video/mp4";
  if (ascii(0, 4) === "\x1a\x45\xdf\xa3") return "video/webm"; // EBML (webm/mkv)

  return (fallback || "application/octet-stream").split(";")[0].trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Résolution de la source (clé R2 permanente / URL https / data URI)  */
/* ------------------------------------------------------------------ */

function estDataUriMedia(valeur: string): boolean {
  return valeur.startsWith("data:") && valeur.length < MAX_ANALYSE_OCTETS * 2;
}

async function chargerBufferSource(params: {
  userId: string;
  source: string;
  contentTypeAnnonce?: string;
}): Promise<{ buffer: Buffer; mime: string }> {
  const source = params.source.trim();

  if (estDataUriMedia(source)) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/s.exec(source);
    if (!match) throw new Error("Data URI média invalide.");
    const buffer = Buffer.from(match[2] ?? "", "base64");
    if (buffer.length === 0 || buffer.length > MAX_ANALYSE_OCTETS) {
      throw new Error(`Média hors limite de taille (max ${Math.round(MAX_ANALYSE_OCTETS / 1_000_000)} Mo).`);
    }
    return { buffer, mime: match[1] ?? "application/octet-stream" };
  }

  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
    if (!response.ok) throw new Error(`Récupération du média impossible (HTTP ${response.status}).`);
    const mime = (response.headers.get("content-type") || "").split(";")[0].trim();
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new Error("Le média source est vide.");
    if (buffer.length > MAX_ANALYSE_OCTETS) {
      throw new Error(`Média trop volumineux (max ${Math.round(MAX_ANALYSE_OCTETS / 1_000_000)} Mo).`);
    }
    return { buffer, mime: snifferContentTypeMedia(buffer, mime) };
  }

  if (params.source.startsWith("users/")) {
    if (!isOwnedPermanentKey(params.userId, params.source)) {
      throw new Error("Chemin hors du stockage permanent du compte.");
    }
    if (!isR2Configured()) throw new Error("Stockage permanent non configuré.");
    const buffer = await downloadFromR2(params.source, MAX_ANALYSE_OCTETS);
    if (!buffer || buffer.length === 0) throw new Error("Média introuvable dans le stockage.");
    return { buffer, mime: snifferContentTypeMedia(buffer, params.contentTypeAnnonce ?? "") };
  }

  throw new Error("Source média non reconnue (clé permanente, URL https ou data URI attendus).");
}

/* ------------------------------------------------------------------ */
/* Analyse IMAGE (sharp)                                              */
/* ------------------------------------------------------------------ */

/** Convertit un pixel RGB en hex (palettes lisibles). */
function hexDe(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Palette dominante déterministe : quantification 4 bits/canal d'un échantillon. */
async function paletteDominante(
  buffer: Buffer,
  taille: number,
): Promise<Array<{ hex: string; part: number }>> {
  const { default: sharp } = await import("sharp");
  const brut = await sharp(buffer, { failOn: "none" })
    .resize(32, 32, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer();
  const compte = new Map<number, number>();
  for (let i = 0; i + 2 < brut.length; i += 3) {
    const cle = ((brut[i]! >> 4) << 8) | ((brut[i + 1]! >> 4) << 4) | (brut[i + 2]! >> 4);
    compte.set(cle, (compte.get(cle) ?? 0) + 1);
  }
  const total = Math.max(1, Math.floor(brut.length / 3));
  const triees = [...compte.entries()].sort((a, b) => b[1] - a[1]).slice(0, taille);
  return triees.map(([cle, n]) => ({
    hex: hexDe(((cle >> 8) & 0xf) * 17, ((cle >> 4) & 0xf) * 17, (cle & 0xf) * 17),
    part: Math.round((n / total) * 100),
  }));
}

function qualifierLuminance(moyenne: number): string {
  if (moyenne < 64) return "globalement sombre";
  if (moyenne < 128) return "tonalité médiane sombre";
  if (moyenne < 192) return "tonalité médiane claire";
  return "globalement lumineuse";
}

function qualifierContraste(ecartType: number): string {
  if (ecartType < 24) return "faible contraste (plats)";
  if (ecartType < 52) return "contraste modéré";
  if (ecartType < 80) return "contraste marqué";
  return "contraste très élevé";
}

function qualifierTemperature(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (r > b + 24) return "tons chauds";
  if (b > r + 24) return "tons froids";
  return "tons neutres";
}

export async function analyserImageLocale(buffer: Buffer, mime: string): Promise<AnalyseMediaLocale> {
  const { default: sharp } = await import("sharp");
  const image = sharp(buffer, { failOn: "none" });
  const meta = await image.metadata();
  const stats = await image.stats();

  const largeur = meta.width ?? 0;
  const hauteur = meta.height ?? 0;
  const canaux = stats.channels.slice(0, 3);
  const luminance = canaux.length > 0
    ? Math.round(
        canaux.reduce((somme, c, i) => somme + c.mean * [0.299, 0.587, 0.114][i]!, 0) /
          Math.max(0.001, [0.299, 0.587, 0.114].reduce((s, w) => s + w, 0)),
      )
    : 0;
  const ecartType = Math.round(canaux.reduce((s, c) => s + c.stdev, 0) / Math.max(1, canaux.length));
  const palette = await paletteDominante(buffer, 5);
  const orientation = largeur === hauteur
    ? "carré"
    : largeur > hauteur
      ? "paysage"
      : "portrait";
  const entropie = stats.entropy !== undefined ? Math.round(stats.entropy * 10) / 10 : undefined;

  const paletteTexte = palette
    .slice(0, 3)
    .map((c) => `${c.hex} (${c.part} %, ${qualifierTemperature(c.hex)})`)
    .join(", ");

  const resume = [
    `Image ${meta.format?.toUpperCase() ?? mime} de ${largeur}×${hauteur} px (orientation ${orientation}).`,
    `Couleurs dominantes : ${paletteTexte}.`,
    `Composition ${qualifierLuminance(luminance)} (luminosité moyenne ${Math.round((luminance / 255) * 100)} %), ${qualifierContraste(ecartType)}${entropie !== undefined ? `, richesse de détails ${entropie}/8 bits` : ""}.`,
  ].join(" ");

  return {
    kind: "image",
    mime,
    tailleOctets: buffer.length,
    resume,
    details: {
      format: meta.format,
      largeur,
      hauteur,
      orientation,
      luminanceMoyenne: luminance,
      ecartType,
      entropie,
      palette,
      opaque: stats.isOpaque,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Bac à sable temporaire (ffprobe / ffmpeg volumedetect / frames)     */
/* ------------------------------------------------------------------ */

async function avecRepertoireTemporaire<T>(
  travail: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "gen3ia-analyse-"));
  try {
    return await travail(dir);
  } finally {
    await cleanupTmpDir(dir);
  }
}

/** Parse `mean_volume: -18.5 dB` / `max_volume: -3.2 dB` de volumedetect. */
function parserVolumes(stderr: string): { moyenDb?: number; creteDb?: number } {
  const moyen = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr);
  const crete = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr);
  return {
    moyenDb: moyen ? Number(moyen[1]) : undefined,
    creteDb: crete ? Number(crete[1]) : undefined,
  };
}

/** Écrit le buffer source dans le bac à sable avec une extension sûre. */
async function ecrireSource(dir: string, buffer: Buffer, mime: string): Promise<string> {
  const ext =
    mime === "audio/mpeg" ? "mp3"
    : mime === "audio/wav" ? "wav"
    : mime === "audio/ogg" ? "ogg"
    : mime === "audio/flac" ? "flac"
    : mime === "audio/mp4" ? "m4a"
    : mime === "video/webm" ? "webm"
    : mime === "video/quicktime" ? "mov"
    : "src";
  const nom = `source.${ext}`;
  await writeFile(path.join(dir, nom), buffer);
  return nom;
}

/* ------------------------------------------------------------------ */
/* Analyse AUDIO                                                       */
/* ------------------------------------------------------------------ */

function formatterDuree(secondes: number): string {
  if (!Number.isFinite(secondes) || secondes <= 0) return "durée inconnue";
  const m = Math.floor(secondes / 60);
  const s = Math.round(secondes % 60);
  return m > 0 ? `${m} min ${s.toString().padStart(2, "0")} s` : `${s} s`;
}

function decrireDynamique(moyenDb?: number, creteDb?: number): string {
  if (moyenDb === undefined && creteDb === undefined) return "";
  const parts: string[] = [];
  if (moyenDb !== undefined) parts.push(`volume moyen ${moyenDb.toFixed(1)} dB`);
  if (creteDb !== undefined) parts.push(`crêtes à ${creteDb.toFixed(1)} dB`);
  let qualifie = "";
  if (moyenDb !== undefined && creteDb !== undefined) {
    const dynamique = creteDb - moyenDb;
    if (dynamique >= 14) qualifie = "dynamique très contrastée (silences et pics marqués)";
    else if (dynamique >= 8) qualifie = "dynamique contrastée";
    else qualifie = "niveau sonore homogène (compression élevée)";
  }
  return `(${parts.join(", ")} — ${qualifie || "mesure énergétique brute"})`;
}

async function analyserAudioLocale(buffer: Buffer, mime: string): Promise<AnalyseMediaLocale> {
  return avecRepertoireTemporaire(async (dir) => {
    const source = await ecrireSource(dir, buffer, mime);
    const probe = await probeMedia(source, dir);

    // Profil énergétique réel (volumedetect — aucun décodage livré, mesure seule).
    let volumes: { moyenDb?: number; creteDb?: number } = {};
    try {
      const resultat = await runFfmpeg({
        args: ["-i", source, "-af", "volumedetect", "-f", "null", "-"],
        cwd: dir,
        outputDurationSec: Math.min(120, probe.durationSec ?? 30) + 15,
      });
      volumes = parserVolumes(resultat.stderr);
    } catch {
      // Fail-soft : la mesure de volume est un plus, pas un prérequis.
    }

    const canaux = probe.hasAudio ? "piste audio présente" : "AUCUNE piste audio détectée";
    const debitMoyen = probe.durationSec && probe.durationSec > 0
      ? Math.round((buffer.length * 8) / probe.durationSec / 1000)
      : undefined;

    const resume = [
      `Audio ${mime.replace("audio/", "").toUpperCase()} — ${formatterDuree(probe.durationSec ?? NaN)}, ${canaux}${probe.audioCodec ? ` (codec ${probe.audioCodec})` : ""}${debitMoyen ? `, débit moyen ≈ ${debitMoyen} kbit/s` : ""}.`,
      decrireDynamique(volumes.moyenDb, volumes.creteDb),
      "Le contenu parlé ou chanté n'est PAS transcrit : le moteur local mesure les caractéristiques acoustiques, il n'inclut pas de reconnaissance vocale.",
    ].filter(Boolean).join(" ");

    return {
      kind: "audio" as const,
      mime,
      tailleOctets: buffer.length,
      resume,
      details: {
        dureeSecondes: probe.durationSec,
        codec: probe.audioCodec,
        canaux: probe.hasAudio ? 2 : 0,
        debitMoyenKbps: debitMoyen,
        volumeMoyenDb: volumes.moyenDb,
        volumeCreteDb: volumes.creteDb,
      },
    };
  });
}

/* ------------------------------------------------------------------ */
/* Analyse VIDÉO (ffprobe + images clées + sharp)                      */
/* ------------------------------------------------------------------ */

interface InstantAnalyses {
  aSecondes: number;
  luminance: number;
  palette: string;
}

async function luminanceEtPaletteFrame(dir: string, nom: string): Promise<{ luminance: number; dominante: string }> {
  const { default: sharp } = await import("sharp");
  const brut = await sharp(path.join(dir, nom), { failOn: "none" })
    .resize(16, 16, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer();
  let somme = 0;
  let n = 0;
  const compte = new Map<number, number>();
  for (let i = 0; i + 2 < brut.length; i += 3) {
    somme += 0.299 * brut[i]! + 0.587 * brut[i + 1]! + 0.114 * brut[i + 2]!;
    n += 1;
    const cle = ((brut[i]! >> 4) << 8) | ((brut[i + 1]! >> 4) << 4) | (brut[i + 2]! >> 4);
    compte.set(cle, (compte.get(cle) ?? 0) + 1);
  }
  const gagnant = [...compte.entries()].sort((a, b) => b[1] - a[1])[0];
  const dominante = gagnant
    ? hexDe(((gagnant[0] >> 8) & 0xf) * 17, ((gagnant[0] >> 4) & 0xf) * 17, (gagnant[0] & 0xf) * 17)
    : "#808080";
  return { luminance: n > 0 ? Math.round(somme / n) : 0, dominante };
}

async function analyserVideoLocale(buffer: Buffer, mime: string): Promise<AnalyseMediaLocale> {
  return avecRepertoireTemporaire(async (dir) => {
    const source = await ecrireSource(dir, buffer, mime);
    const probe = await probeMedia(source, dir);
    const duree = probe.durationSec ?? 0;

    // Extraction d'images clés aux instants 10 % / 50 % / 90 % (recherche rapide -ss avant -i).
    const instants: InstantAnalyses[] = [];
    if (duree > 0.5) {
      const cibles = [0.1, 0.5, 0.9].slice(0, FRAMES_PAR_VIDEO);
      for (let i = 0; i < cibles.length; i++) {
        const t = Math.max(0, Math.min(duree - 0.05, duree * cibles[i]!));
        const nomFrame = `frame-${i}.jpg`;
        try {
          await runFfmpeg({
            args: ["-ss", t.toFixed(2), "-i", source, "-frames:v", "1", "-q:v", "3", nomFrame],
            cwd: dir,
            outputDurationSec: 30,
          });
          const mesure = await luminanceEtPaletteFrame(dir, nomFrame);
          instants.push({
            aSecondes: Math.round(t),
            luminance: mesure.luminance,
            palette: `${mesure.dominante} (${qualifierTemperature(mesure.dominante)})`,
          });
        } catch {
          // Image clé indisponible à cet instant (fail-soft, on continue).
        }
      }
    }

    const narrationFrames = instants.length > 0
      ? `Images clés analysées : ${instants
          .map((i) => `à ${i.aSecondes} s — ${qualifierLuminance(i.luminance)}, dominante ${i.palette}`)
          .join(" ; ")}.`
      : "Aucune image clé extraite (vidéo très courte ou extraction indisponible).";

    const resume = [
      `Vidéo ${mime.replace("video/", "").toUpperCase()}${probe.width && probe.height ? ` ${probe.width}×${probe.height}` : ""} — ${formatterDuree(duree)}${probe.fps ? `, ${probe.fps} img/s` : ""}${probe.videoCodec ? `, vidéo ${probe.videoCodec}` : ""}${probe.audioCodec ? `, audio ${probe.audioCodec}` : ", sans piste audio"}.`,
      narrationFrames,
    ].join(" ");

    return {
      kind: "video",
      mime,
      tailleOctets: buffer.length,
      resume,
      details: {
        dureeSecondes: probe.durationSec,
        largeur: probe.width,
        hauteur: probe.height,
        fps: probe.fps,
        codecVideo: probe.videoCodec,
        codecAudio: probe.audioCodec,
        instants: instants.map((i) => ({ a: i.aSecondes, luminance: i.luminance, dominante: i.palette })),
      },
    };
  });
}

/* ------------------------------------------------------------------ */
/* Point d'entrée + contexte chat                                      */
/* ------------------------------------------------------------------ */

/**
 * Analyse un média identifié par clé permanente / URL / data URI.
 * Retourne null si le type n'est pas un média analysable (fail-soft) ;
 * lève une Error lisible si le média EST un média mais reste illisible.
 */
export async function analyserMediaSource(params: {
  userId: string;
  path?: string;
  url?: string;
  filename?: string;
  contentType?: string;
}): Promise<AnalyseMediaLocale | null> {
  const source = params.path?.trim() || params.url?.trim() || "";
  if (!source) return null;

  const charge = await chargerBufferSource({
    userId: params.userId,
    source,
    contentTypeAnnonce: params.contentType,
  });
  const mime = snifferContentTypeMedia(charge.buffer, charge.mime || params.contentType || "");

  if (mime.startsWith("image/")) return analyserImageLocale(charge.buffer, mime);
  if (mime.startsWith("audio/")) return analyserAudioLocale(charge.buffer, mime);
  if (mime.startsWith("video/")) return analyserVideoLocale(charge.buffer, mime);
  return null;
}

const MIME_MEDIA_RE = /^(image|audio|video)\//;
const EXT_MEDIA_RE = /\.(png|jpe?g|gif|webp|avif|svg|mp3|wav|m4a|aac|ogg|oga|opus|flac|mp4|webm|mov|m4v|mkv)$/i;

function estPieceJointeMedia(attachment: MessageAttachment): boolean {
  if (attachment.contentType && MIME_MEDIA_RE.test(attachment.contentType)) return true;
  return EXT_MEDIA_RE.test(attachment.filename ?? "");
}

/**
 * Construit le bloc de contexte d'analyse média pour le tour de chat :
 * jusqu'à `maxMedias` pièces jointes audio/vidéo (les images gardent la voie
 * vision native) réellement analysées localement. Fail-soft TOTAL : toute
 * pièce jointe qui échoue est signalée honnêtement, jamais bloquante.
 */
export async function construireContexteAnalyseMedias(params: {
  userId: string;
  attachments?: MessageAttachment[];
  maxMedias?: number;
}): Promise<string> {
  const attachments = (params.attachments ?? []).filter(estPieceJointeMedia);
  if (attachments.length === 0) return "";

  const maxMedias = Math.max(1, params.maxMedias ?? 2);
  const blocs: string[] = [];

  for (const attachment of attachments.slice(0, maxMedias)) {
    const nom = attachment.filename?.slice(0, 120) || attachment.path || "média";
    try {
      const analyse = await analyserMediaSource({
        userId: params.userId,
        path: attachment.path,
        url: attachment.url,
        contentType: attachment.contentType,
      });
      if (!analyse) {
        blocs.push(`— « ${nom} » : type non analysable localement (métadonnées seules).`);
        continue;
      }
      blocs.push(`— « ${nom} » : ${analyse.resume}`);
    } catch (erreur) {
      const raison = erreur instanceof Error ? erreur.message.slice(0, 160) : "analyse impossible";
      blocs.push(`— « ${nom} » : analyse indisponible (${raison}).`);
    }
  }

  const restants = attachments.length - Math.min(maxMedias, attachments.length);
  const entete = `[ANALYSE LOCALE DES MÉDIAS JOINTS (mesures réelles du moteur Gen3ia — aucune perception inventée)${restants > 0 ? ` — ${restants} média(s) supplémentaire(s) non analysé(s)` : ""} :]`;
  return `${entete}\n${blocs.join("\n")}`;
}
