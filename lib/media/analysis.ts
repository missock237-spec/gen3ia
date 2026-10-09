import "server-only";

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generate } from "@/lib/ai/router";
import { downloadFromR2 } from "@/lib/storage/r2";
import { transcribeAudioToText } from "@/lib/knowledge/perception";
import { cleanupTmpDir, probeMedia, runFfmpeg } from "@/lib/video/ffmpeg";
import type { MessageAttachment } from "@/lib/domain/conversations/types";

/**
 * ANALYSE MÉDIA (image / audio / vidéo) — expérience utilisateur enrichie.
 *
 * Trois analyses RÉELLES, branchées sur les fournisseurs déjà configurés
 * (aucune nouvelle dépendance) :
 *  - IMAGE : modèle VISION du routeur IA (parts image_url, même contrat que
 *    l'OCR de lib/knowledge/perception.ts) — description détaillée, texte
 *    visible, objets/composition, réponse à la question posée ;
 *  - AUDIO : ASR ElevenLabs Scribe (scribe_v1, même clé que la synthèse
 *    vocale) puis analyse du transcript par le LLM ;
 *  - VIDÉO : ffprobe (métadonnées réelles) + extraction de frames clés
 *    FFmpeg (bac à sable du pipeline vidéo) + piste audio → Scribe, puis
 *    UNE analyse vision sur les frames enrichie du transcript.
 *
 * Les échecs sont HONNÊTES : sans fournisseur configuré, l'erreur nomme la
 * variable d'environnement manquante — jamais d'analyse inventée.
 */

const ANALYSIS_MAX_IMAGE_BYTES = 8_000_000;
const ANALYSIS_MAX_AUDIO_BYTES = 20_000_000;
const ANALYSIS_MAX_VIDEO_BYTES = 80_000_000;
/** Frames clés extraites par vidéo (réparties sur la durée réelle). */
const VIDEO_ANALYSIS_MAX_FRAMES = 6;
/** Piste audio transcrite au maximum (10 minutes — budget serverless). */
const VIDEO_AUDIO_CAPTURE_MAX_SEC = 600;

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** Extensions audio acceptées par Scribe (doc ElevenLabs). */
const AUDIO_EXTENSIONS = /\.(mp3|wav|m4a|ogg|flac|webm|aac|opus)$/i;
const VIDEO_MIME_PREFIX = "video/";

export type MediaKind = "image" | "audio" | "video";

export interface MediaAnalysisResult {
  kind: MediaKind;
  filename: string;
  analysis: string;
  /** Fournisseurs réellement utilisés (ex. "scribe_v1:fr + vision"). */
  providerLabel: string;
  /** Métadonnées vidéo réelles quand disponibles (probe ffprobe). */
  metadata?: { durationSec?: number; width?: number; height?: number; fps?: number };
}

const VISION_ANALYST_SYSTEM =
  "Tu es un analyste visuel expert. Décris l'image avec précision et structure : " +
  "1) scène et sujet principal ; 2) éléments visibles (personnes, objets, textes lisibles — transcription exacte) ; " +
  "3) style, couleurs, composition, qualité technique ; 4) contexte ou action en cours. " +
  "Réponds en français, de façon factuelle — n'invente JAMAIS ce qui n'est pas visible. " +
  "Si l'utilisateur pose une question précise, réponds-y d'abord.";

function questionOrDefault(question?: string): string {
  const trimmed = question?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.slice(0, 1200) : "Décris ce média en détail.";
}

/** Analyse RÉELLE d'une image par un modèle vision du routeur. */
export async function analyzeImageContent(input: {
  buffer: Buffer;
  mimeType: string;
  filename?: string;
  question?: string;
}): Promise<{ analysis: string; providerLabel: string }> {
  const mimeType = input.mimeType.toLowerCase().split(";")[0].trim();
  if (!IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(`Analyse d'image : format non pris en charge (${mimeType || "inconnu"}). Formats acceptés : PNG, JPEG, WEBP, GIF.`);
  }
  if (input.buffer.length > ANALYSIS_MAX_IMAGE_BYTES) {
    throw new Error(`Image trop volumineuse pour l'analyse (max ${Math.round(ANALYSIS_MAX_IMAGE_BYTES / 1_000_000)} Mo).`);
  }
  const response = await generate({
    task: "reasoning",
    requiresVision: true,
    messages: [
      { role: "system", content: VISION_ANALYST_SYSTEM },
      {
        role: "user",
        content: `${questionOrDefault(input.question)}${input.filename ? ` (fichier : « ${input.filename.slice(0, 120)} »)` : ""}.`,
        images: [{ mediaType: mimeType as "image/png", source: { type: "base64", data: input.buffer.toString("base64") } }],
      },
    ],
  });
  const analysis = response.text.trim();
  if (!analysis) throw new Error("Analyse d'image : le modèle vision n'a rien renvoyé. Réessayez.");
  return { analysis, providerLabel: "vision" };
}

/** Analyse RÉELLE d'un fichier audio : transcription Scribe + synthèse LLM. */
export async function analyzeAudioContent(input: {
  buffer: Buffer;
  filename: string;
  mimeType?: string;
  question?: string;
}): Promise<{ analysis: string; providerLabel: string }> {
  if (input.buffer.length > ANALYSIS_MAX_AUDIO_BYTES) {
    throw new Error(`Audio trop volumineux pour l'analyse (max ${Math.round(ANALYSIS_MAX_AUDIO_BYTES / 1_000_000)} Mo).`);
  }
  const transcription = await transcribeAudioToText({ buffer: input.buffer, filename: input.filename, mimeType: input.mimeType });
  if (!transcription.text) {
    throw new Error("Analyse audio : aucune parole détectée dans le fichier.");
  }
  const response = await generate({
    task: "chat",
    messages: [
      {
        role: "system",
        content:
          "Tu es un analyste audio expert. À partir de la transcription fournie (ASR réel ElevenLabs), rédige en français : " +
          "1) résumé du contenu ; 2) points clés ou informations importantes ; 3) ton/contexte apparent ; " +
          "4) réponse directe à la question de l'utilisateur si elle est posée. N'invente RIEN hors transcript.",
      },
      {
        role: "user",
        content:
          `Question : ${questionOrDefault(input.question)}\n` +
          `Transcription du fichier « ${input.filename.slice(0, 120)} » :\n${transcription.text.slice(0, 24_000)}`,
      },
    ],
  });
  const analysis = response.text.trim();
  if (!analysis) throw new Error("Analyse audio : la synthèse n'a rien renvoyé. Réessayez.");
  return { analysis: `${analysis}\n\nTranscription :\n${transcription.text.slice(0, 8_000)}`, providerLabel: transcription.providerLabel + " + llm" };
}

/**
 * Analyse RÉELLE d'une vidéo : métadonnées ffprobe, frames clés FFmpeg
 * (bac à sable du pipeline vidéo), piste audio → Scribe, puis UNE analyse
 * vision sur les frames enrichie du transcript.
 */
export async function analyzeVideoContent(input: {
  buffer: Buffer;
  filename: string;
  question?: string;
}): Promise<MediaAnalysisResult> {
  if (input.buffer.length > ANALYSIS_MAX_VIDEO_BYTES) {
    throw new Error(`Vidéo trop volumineuse pour l'analyse (max ${Math.round(ANALYSIS_MAX_VIDEO_BYTES / 1_000_000)} Mo).`);
  }
  const dir = await mkdtemp(join(tmpdir(), "g3ia-analyze-"));
  try {
    const extension = input.filename.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() ?? "mp4";
    const inputPath = join(dir, `source.${extension}`);
    await writeFile(inputPath, input.buffer);

    const probe = await probeMedia(inputPath, dir);
    const durationSec = probe.durationSec && probe.durationSec > 0 ? probe.durationSec : 0;

    // Frames clés réparties sur la durée réelle (jamais uniquement le début).
    const frameCount = Math.max(1, Math.min(VIDEO_ANALYSIS_MAX_FRAMES, Math.ceil(durationSec / 10) || VIDEO_ANALYSIS_MAX_FRAMES));
    const frameBuffers: Buffer[] = [];
    for (let index = 0; index < frameCount; index += 1) {
      const timestamp = durationSec > 0 ? Math.min(durationSec * ((index + 1) / (frameCount + 1)), Math.max(durationSec - 0.5, 0)) : index * 2;
      const framePath = `frame-${index}.jpg`;
      await runFfmpeg({
        args: ["-ss", timestamp.toFixed(2), "-i", `source.${extension}`, "-frames:v", "1", "-vf", "scale='min(1024,iw)':-2", "-q:v", "5", framePath],
        cwd: dir,
        outputDurationSec: Math.min(Math.max(durationSec, 5), 60),
      });
      frameBuffers.push(await readFile(join(dir, framePath)));
    }

    // Piste audio → transcription Scribe (16 kHz mono WAV, plafonnée).
    let transcript: string | null = null;
    if (probe.hasAudio) {
      try {
        await runFfmpeg({
          args: ["-i", `source.${extension}`, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", "-t", String(VIDEO_AUDIO_CAPTURE_MAX_SEC), "audio.wav"],
          cwd: dir,
          outputDurationSec: Math.min(Math.max(durationSec, 5), 90),
        });
        const audio = await readFile(join(dir, "audio.wav"));
        transcript = (await transcribeAudioToText({ buffer: audio, filename: "audio.wav", mimeType: "audio/wav" })).text || null;
      } catch (audioError) {
        console.warn("[media-analysis] transcription de la piste audio impossible:", audioError instanceof Error ? audioError.message : audioError);
      }
    }

    // Analyse vision UNIQUE sur les frames + transcript + métadonnées.
    const metadataLine =
      `Durée ${durationSec ? `${Math.round(durationSec)} s` : "inconnue"}, ` +
      `${probe.width ?? "?"}×${probe.height ?? "?"} px, ${Math.round(probe.fps ?? 0)} fps, ` +
      `audio ${probe.hasAudio ? "présent" : "absent"}, codec ${probe.videoCodec ?? "?"}.`;
    const response = await generate({
      task: "reasoning",
      requiresVision: true,
      messages: [
        {
          role: "system",
          content:
            "Tu es un analyste vidéo expert. On te donne des frames CLÉS extraites d'une vidéo (ordre chronologique) " +
            "et éventuellement la transcription de sa piste audio. Rédige en français une analyse structurée : " +
            "1) résumé du contenu ; 2) description chronologique des moments clés ; 3) texte visible/parlé important (transcription exacte) ; " +
            "4) qualité technique et points d'amélioration ; 5) réponse directe à la question posée. N'invente RIEN.",
        },
        {
          role: "user",
          content:
            `Question : ${questionOrDefault(input.question)}\n` +
            `Métadonnées : ${metadataLine}\n` +
            (transcript ? `Transcription de la piste audio :\n${transcript.slice(0, 12_000)}\n` : "(piste audio absente ou non transcrite)\n") +
            `Fichier : « ${input.filename.slice(0, 120)} » — les ${frameBuffers.length} frames jointes sont chronologiques.`,
          ...(frameBuffers.length > 0
            ? {
                images: frameBuffers.map((buffer) => ({
                  mediaType: "image/jpeg" as const,
                  source: { type: "base64" as const, data: buffer.toString("base64") },
                })),
              }
            : {}),
        },
      ],
    });
    const analysis = response.text.trim();
    if (!analysis) throw new Error("Analyse vidéo : le modèle vision n'a rien renvoyé. Réessayez.");
    return {
      kind: "video",
      filename: input.filename,
      analysis,
      providerLabel: `ffprobe + ffmpeg (${frameCount} frames)${transcript ? " + scribe_v1" : ""} + vision`,
      metadata: { durationSec: probe.durationSec, width: probe.width, height: probe.height, fps: probe.fps },
    };
  } finally {
    await cleanupTmpDir(dir);
  }
}

/** Dispatcher par type MIME (ou extension en repli). */
export async function analyzeMediaContent(input: {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  question?: string;
}): Promise<MediaAnalysisResult> {
  const mimeType = (input.mimeType || "").toLowerCase().split(";")[0].trim();
  if (mimeType.startsWith(VIDEO_MIME_PREFIX) || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(input.filename)) {
    const result = await analyzeVideoContent({ buffer: input.buffer, filename: input.filename, question: input.question });
    return { ...result, kind: "video" };
  }
  if (mimeType.startsWith("audio/") || AUDIO_EXTENSIONS.test(input.filename)) {
    const audio = await analyzeAudioContent({ buffer: input.buffer, filename: input.filename, mimeType: mimeType || "audio/mpeg", question: input.question });
    return { kind: "audio", filename: input.filename, analysis: audio.analysis, providerLabel: audio.providerLabel };
  }
  if (IMAGE_MIME_TYPES.has(mimeType) || /\.(png|jpe?g|webp|gif)$/i.test(input.filename)) {
    const image = await analyzeImageContent({ buffer: input.buffer, mimeType: mimeType || "image/png", filename: input.filename, question: input.question });
    return { kind: "image", filename: input.filename, analysis: image.analysis, providerLabel: image.providerLabel };
  }
  throw new Error(`Type de média non analysable (${mimeType || input.filename || "inconnu"}). Formats : image, audio, vidéo.`);
}

/**
 * Résolution SÉCURISÉE d'une pièce jointe / source : clé R2 du PROPRIÉTAIRE
 * uniquement (préfixe users/<uid>/ vérifié — aucune traversée inter-compte)
 * ou URL https publique (timeout + plafond de taille).
 */
export async function loadMediaSource(input: {
  userId: string;
  path?: string;
  url?: string;
  fallbackMimeType?: string;
  fallbackFilename?: string;
}): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  const filename = (input.fallbackFilename || "media").slice(0, 200);
  if (typeof input.path === "string" && input.path.trim()) {
    const path = input.path.trim();
    const prefix = `users/${input.userId}/`;
    if (!path.startsWith(prefix)) {
      throw new Error("Accès refusé : la clé de stockage n'appartient pas à votre espace.");
    }
    const buffer = await downloadFromR2(path);
    return { buffer, mimeType: input.fallbackMimeType || mimeTypeFromKey(path) || "application/octet-stream", filename: filename === "media" ? path.split("/").pop() || filename : filename };
  }
  if (typeof input.url === "string" && /^https:\/\//i.test(input.url.trim())) {
    const response = await fetch(input.url.trim(), { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Téléchargement du média impossible (HTTP ${response.status}).`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length === 0) throw new Error("Le média téléchargé est vide.");
    return {
      buffer,
      mimeType: input.fallbackMimeType || response.headers.get("content-type")?.split(";")[0]?.trim() || mimeTypeFromKey(filename) || "application/octet-stream",
      filename,
    };
  }
  throw new Error("Aucune source de média fournie (path R2 du propriétaire ou URL https attendus).");
}

function mimeTypeFromKey(key: string): string | null {
  const ext = key.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Connexion CONVERSATION — contexte d'analyse injecté au tour chat     */
/* ------------------------------------------------------------------ */

/** Plafond par tour : 2 médias analysés (budget temps/latence garanti). */
const CONTEXT_MAX_MEDIA = 2;
/** Budget temps d'UNE analyse dans le tour conversationnel. */
const CONTEXT_ANALYSIS_BUDGET_MS = 90_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} : délai dépassé (${Math.round(ms / 1000)} s).`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isMediaAttachment(attachment: MessageAttachment): boolean {
  const mime = attachment.contentType?.toLowerCase() ?? "";
  return mime.startsWith("audio/") || mime.startsWith("video/") || AUDIO_EXTENSIONS.test(attachment.filename) || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(attachment.filename);
}

/**
 * Analyse RÉELLE des médias (audio/vidéo) joints au message courant, en
 * fail-soft total (jamais bloquant) — retourne un bloc de contexte injecté
 * dans le prompt du tour (même pattern que filesContext/webContext). Les
 * IMAGES gardent la voie vision native (imagesForModel) — non dupliquée.
 */
export async function analyzeAttachedMediaContext(
  userId: string,
  attachments: MessageAttachment[] | undefined,
  message: string,
): Promise<string> {
  const media = (attachments ?? []).filter(isMediaAttachment).slice(0, CONTEXT_MAX_MEDIA);
  if (media.length === 0) return "";

  const question = message.trim().slice(0, 500);
  const parts: string[] = [];
  for (const attachment of media) {
    try {
      const source = await loadMediaSource({
        userId,
        path: attachment.path,
        url: attachment.url,
        fallbackMimeType: attachment.contentType,
        fallbackFilename: attachment.filename,
      });
      const analysis = await withTimeout(
        analyzeMediaContent({ buffer: source.buffer, mimeType: source.mimeType, filename: source.filename, question }),
        CONTEXT_ANALYSIS_BUDGET_MS,
        `analyse de « ${source.filename} »`,
      );
      parts.push(`— « ${analysis.filename} » (${analysis.kind}${analysis.metadata?.durationSec ? `, ${Math.round(analysis.metadata.durationSec)} s` : ""}) :\n${analysis.analysis.slice(0, 6_000)}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 200) : "erreur inconnue";
      parts.push(`— « ${attachment.filename} » : analyse indisponible (${reason}).`);
    }
  }
  if (parts.length === 0) return "";
  return (
    "\n\nANALYSE RÉELLE des médias joints au message (produite par la plateforme — appuie-toi sur ces faits, " +
    "n'invente JAMAIS un contenu de média que tu ne vois pas) :\n" +
    parts.join("\n")
  );
}
