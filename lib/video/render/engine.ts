import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 18 : Render Engine (FFmpeg réel).
 *
 * Exécute un plan de rendu ÉTAPE PAR ÉTAPE avec CHECKPOINTS :
 * chaque segment rendu est marqué dans le job — si le rendu échoue à 73 %,
 * la reprise repart au dernier checkpoint sans tout recommencer (spec §19).
 *
 * Pipeline : download → segments → transitions (xfade) → audio (ducking
 * sidechain) → sous-titres (ASS brûlés) → QC → exports → finalize (R2).
 *
 * Toutes les entrées sont matérialisées localement (aucune URL distante
 * dans FFmpeg — SSRF impossible), chaque commande est timeoutée, le tmp du
 * job est purgé à la fin.
 */

import { mkdtemp, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderJob, RenderPlan, VideoAsset } from "@/lib/video/types";
import { dimensionsFor } from "@/lib/video/types";
import { runFfmpeg, probeMedia, cleanupTmpDir } from "@/lib/video/ffmpeg";
import {
  buildSegmentFfmpegArgs,
  buildTransitionFfmpegArgs,
  buildAudioMixFfmpegArgs,
  buildExportFfmpegArgs,
  EXPORT_GEOMETRY,
} from "@/lib/video/render/planner";
import { resolveFontFile } from "@/lib/video/render/fonts";

export interface EngineIo {
  /** Récupère un asset par id (déjà vérifié propriétaire). */
  getAsset: (assetId: string) => Promise<VideoAsset | null>;
  /** Matérialise un asset (id) dans le tmp (téléchargement R2 → fichier). */
  materialize: (asset: VideoAsset, fileName: string) => Promise<string>;
  /** Matérialise un asset par clé R2 (clé déjà vérifiée propriétaire). */
  materializeByName: (r2Key: string, fileName: string) => Promise<string>;
  /** Écrit un fichier texte (ASS…) dans le tmp. */
  writeTmp: (fileName: string, content: string) => Promise<string>;
  /** Upload d'un fichier rendu vers R2. */
  uploadRender: (fileName: string, body: Buffer, domain: "renders" | "versions") => Promise<string>;
  /** Journal de progression (checkpoint). */
  log: (message: string) => Promise<void>;
  tmpDir: string;
}

/** Exécute l'étape « segments » : rend chaque segment non encore terminé. */
export async function renderSegments(params: {
  plan: RenderPlan;
  io: EngineIo;
  userId: string;
  completedSegments: number[];
  onSegmentDone: (index: number) => Promise<void>;
}): Promise<string[]> {
  const dims = dimensionsFor(params.plan.aspectRatio, params.plan.resolution);
  const fontFile = await resolveFontFile();
  const segmentFiles: string[] = [];
  for (const segment of params.plan.segments) {
    const outFile = join(params.io.tmpDir, `segment_${String(segment.index).padStart(4, "0")}.mp4`);
    segmentFiles.push(outFile);
    if (params.completedSegments.includes(segment.index)) continue;

    const imageFiles: string[] = [];
    for (const [i, r2Key] of segment.imageR2Keys.entries()) {
      imageFiles.push(await params.io.materializeByName(r2Key, `img_${segment.index}_${i}.png`));
    }

    const args = buildSegmentFfmpegArgs({
      segment,
      ctx: { width: dims.width, height: dims.height, fps: params.plan.fps },
      imageFiles,
      outFile,
      fontFile: fontFile ?? undefined,
    });
    await runFfmpeg({
      args,
      cwd: params.io.tmpDir,
      outputDurationSec: segment.durationSec,
      outputPaths: [outFile],
    });
    await params.onSegmentDone(segment.index);
    await params.io.log(`Segment ${segment.index + 1}/${params.plan.segments.length} rendu (${segment.sceneId}).`);
  }
  return segmentFiles;
}

/**
 * Assemble les segments avec transitions (xfade) — chaîne en une commande
 * par lots bornés (Long Video Engine : jamais tout en mémoire).
 */
export async function assembleTransitions(params: {
  plan: RenderPlan;
  io: EngineIo;
  segmentFiles: string[];
}): Promise<{ file: string; durationSec: number }> {
  const durations: number[] = params.plan.segments.map((s) => s.durationSec);
  const total = durations.reduce((a, b) => a + b, 0);

  if (params.segmentFiles.length === 1) {
    return { file: params.segmentFiles[0], durationSec: round2(total) };
  }

  const built = buildTransitionFfmpegArgs({
    segmentFiles: params.segmentFiles,
    durations,
    transitions: params.plan.transitions,
    outFile: join(params.io.tmpDir, "video_noaudio.mp4"),
    fps: params.plan.fps,
  });
  if (!built) {
    return { file: params.segmentFiles[0], durationSec: round2(total) };
  }
  await runFfmpeg({
    args: built.args,
    cwd: params.io.tmpDir,
    outputDurationSec: built.expectedDurationSec,
    outputPaths: [join(params.io.tmpDir, "video_noaudio.mp4")],
  });
  await params.io.log(`Transitions appliquées (${params.plan.transitions.length} frontières, ${round2(built.expectedDurationSec)} s attendues).`);
  return { file: join(params.io.tmpDir, "video_noaudio.mp4"), durationSec: built.expectedDurationSec };
}

/** Mixe l'audio (narration + musique duckée + SFX) → audio.m4a. */
export async function mixAudio(params: {
  plan: RenderPlan;
  io: EngineIo;
  durationSec: number;
}): Promise<string | null> {
  const mix = params.plan.audioMix;
  const narrationFiles: Array<{ file: string; startSec: number; volume: number; fadeInSec: number; fadeOutSec: number }> = [];
  const sfxFiles: Array<{ file: string; startSec: number; volume: number }> = [];

  for (const item of mix.narration) {
    const asset = await params.io.getAsset(item.assetId);
    if (!asset) continue;
    narrationFiles.push({
      file: await params.io.materialize(asset, `narr_${item.id}.m4a`),
      startSec: item.startSec,
      volume: item.volume,
      fadeInSec: item.fadeInSec,
      fadeOutSec: item.fadeOutSec,
    });
  }
  for (const item of mix.sfx) {
    const asset = await params.io.getAsset(item.assetId);
    if (!asset) continue;
    sfxFiles.push({
      file: await params.io.materialize(asset, `sfx_${item.id}.wav`),
      startSec: item.startSec,
      volume: item.volume,
    });
  }
  let musicFile: string | undefined;
  if (mix.music.length > 0) {
    const musicAsset = await params.io.getAsset(mix.music[0].assetId);
    if (musicAsset) musicFile = await params.io.materialize(musicAsset, "music_bed.wav");
  }

  const args = buildAudioMixFfmpegArgs({
    narrationFiles,
    musicFile,
    musicVolume: mix.music[0]?.volume ?? 0.6,
    sfxFiles,
    ducking: mix.ducking,
    targetLoudnessDb: mix.targetLoudnessDb,
    durationSec: params.durationSec,
    outFile: join(params.io.tmpDir, "audio_final.m4a"),
  });
  if (!args) return null;
  await runFfmpeg({
    args,
    cwd: params.io.tmpDir,
    outputDurationSec: params.durationSec,
    outputPaths: [join(params.io.tmpDir, "audio_final.m4a")],
  });
  await params.io.log("Mixage audio terminé (ducking + normalisation loudness).");
  return join(params.io.tmpDir, "audio_final.m4a");
}

/** Brûle les sous-titres ASS + mux audio → master.mp4. */
export async function finalizeMaster(params: {
  plan: RenderPlan;
  io: EngineIo;
  videoNoAudioFile: string;
  audioFile: string | null;
  durationSec: number;
  burnAssFileName?: string;
}): Promise<string> {
  const outFile = join(params.io.tmpDir, "master.mp4");
  const vf: string[] = [];
  if (params.burnAssFileName) {
    // Copie locale + chemin relatif (subtitles= supporte les chemins relatifs au cwd).
    vf.push(`subtitles=${params.burnAssFileName}:fontsdir=/usr/share/fonts`);
  }
  const args = [
    "-i", params.videoNoAudioFile,
    ...(params.audioFile ? ["-i", params.audioFile] : []),
    ...(vf.length > 0 ? ["-vf", vf.join(",")] : []),
    "-map", "0:v:0",
    ...(params.audioFile ? ["-map", "1:a:0"] : []),
    ...(params.burnAssFileName ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"] : ["-c:v", "copy"]),
    ...(params.audioFile ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
    "-shortest",
    outFile,
  ];
  await runFfmpeg({
    args,
    cwd: params.io.tmpDir,
    outputDurationSec: params.durationSec,
    outputPaths: [outFile],
  });
  await params.io.log("Master assemblé (vidéo + audio + sous-titres).");
  return outFile;
}

/** Produit un format dérivé (9:16, 1:1…) depuis le master. */
export async function renderExportFormat(params: {
  io: EngineIo;
  masterFile: string;
  target: string;
  assFileName?: string;
}): Promise<string> {
  const geometry = EXPORT_GEOMETRY[targetOf(params.target)];
  const outFile = join(params.io.tmpDir, `export_${params.target}.mp4`);
  const args = buildExportFfmpegArgs({
    masterFile: params.masterFile,
    target: params.target,
    outFile,
    assFile: params.assFileName,
  });
  void geometry;
  await runFfmpeg({
    args,
    cwd: params.io.tmpDir,
    outputDurationSec: 60,
    outputPaths: [outFile],
  });
  return outFile;
}

function targetOf(target: string): string {
  return target;
}

/** Upload le master vers R2 et renvoie la clé. */
export async function uploadMaster(params: { io: EngineIo; masterFile: string; projectId: string; jobId: string }): Promise<{ r2Key: string; sizeBytes: number; durationSec: number; width: number; height: number }> {
  const body = await readFile(params.masterFile);
  const r2Key = await params.io.uploadRender(`renders/${params.jobId}/master.mp4`, body, "renders");
  const probe = await probeMedia(params.masterFile, params.io.tmpDir).catch(() => ({} as Awaited<ReturnType<typeof probeMedia>> | Record<string, never>));
  const sizeBytes = (await stat(params.masterFile)).size;
  return {
    r2Key,
    sizeBytes,
    durationSec: (probe as Awaited<ReturnType<typeof probeMedia>>).durationSec ?? 0,
    width: (probe as Awaited<ReturnType<typeof probeMedia>>).width ?? 0,
    height: (probe as Awaited<ReturnType<typeof probeMedia>>).height ?? 0,
  };
}

/** Purge le répertoire tmp du job (fin de job / annulation / échec). */
export async function cleanupJob(job: RenderJob): Promise<void> {
  if (job.tmpDir) await cleanupTmpDir(job.tmpDir);
}

/** Crée le répertoire tmp d'un job. */
export async function createJobTmpDir(jobId: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `gen3ia-render-${jobId.slice(0, 8)}-`));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
