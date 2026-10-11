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
import { basename, join } from "node:path";
import type { RenderJob, RenderPlan, VideoAsset, MediaProbe } from "@/lib/video/types";
import { dimensionsFor } from "@/lib/video/types";
import { runFfmpeg, probeMedia, cleanupTmpDir } from "@/lib/video/ffmpeg";
import {
  buildSegmentFfmpegArgs,
  buildTransitionFfmpegArgs,
  buildAudioMixFfmpegArgs,
  buildExportFfmpegArgs,
  EXPORT_GEOMETRY,
  crfForHeight,
  shouldConcatCopy,
  type MusicTrackInput,
} from "@/lib/video/render/planner";
import { resolveFontFile } from "@/lib/video/render/fonts";
import { mapWithConcurrency, firstRejectedReason } from "@/lib/video/concurrency";

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

/**
 * Exécute l'étape « segments » : rend chaque segment non encore terminé.
 *
 * Task 120 — PARALLÉLISME BORNÉ : `concurrency` processus FFmpeg simultanés
 * (défaut 1 = comportement historique séquentiel). Les échecs sont isolés
 * par segment (le pool attend la fin de la vague avant de propager la
 * PREMIÈRE erreur dans l'ordre des segments — reprise au checkpoint pour les
 * autres). L'ordre de la liste de fichiers est TOUJOURS l'ordre du plan.
 */
export async function renderSegments(params: {
  plan: RenderPlan;
  io: EngineIo;
  userId: string;
  completedSegments: number[];
  onSegmentDone: (index: number) => Promise<void>;
  /** Task 120 — segments rendus en parallèle (borné, mémoire serverless). */
  concurrency?: number;
  /**
   * Task 120 — budget temps du tick : un segment NON DÉMARRÉ après cette
   * échéance est laissé au tick suivant (reprise au checkpoint) au lieu
   * de dépasser l'échéance serverless.
   */
  deadlineMs?: number | null;
}): Promise<string[]> {
  const dims = dimensionsFor(params.plan.aspectRatio, params.plan.resolution);
  const fontFile = await resolveFontFile();
  const segmentFiles: string[] = params.plan.segments.map((segment) =>
    join(params.io.tmpDir, `segment_${String(segment.index).padStart(4, "0")}.mp4`),
  );
  const pending = params.plan.segments.filter((segment) => !params.completedSegments.includes(segment.index));
  if (pending.length > 0) {
    const deadlineMs = typeof params.deadlineMs === "number" && params.deadlineMs > 0 ? params.deadlineMs : null;
    const outcomes = await mapWithConcurrency(
      pending,
      Math.max(1, params.concurrency ?? 1),
      async (segment) => {
        const outFile = join(params.io.tmpDir, `segment_${String(segment.index).padStart(4, "0")}.mp4`);
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
      },
      {
        shouldStart: () => deadlineMs === null || Date.now() < deadlineMs,
      },
    );
    const failure = firstRejectedReason(outcomes);
    if (failure !== undefined) {
      throw failure instanceof Error ? failure : new Error(String(failure));
    }
  }
  return segmentFiles;
}

/**
 * Assemble les segments avec transitions (xfade) — chaîne en une commande
 * par lots bornés (Long Video Engine : jamais tout en mémoire).
 *
 * Task 120 — COUPES FRANCHES = STREAM COPY : quand toutes les frontières
 * sont des coupes (aucun xfade nécessaire), l'assemblage passe par le
 * demuxer concat avec `-c copy` — AUCUN ré-encodage (les segments sortent
 * tous du même encodeur libx264, mêmes codecs et paramètres).
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

  const dims = dimensionsFor(params.plan.aspectRatio, params.plan.resolution);
  const outFile = join(params.io.tmpDir, "video_noaudio.mp4");

  if (shouldConcatCopy(params.plan.transitions, params.segmentFiles.length)) {
    const listContent = params.segmentFiles.map((f) => `file '${basename(f)}'`).join("\n") + "\n";
    await params.io.writeTmp("concat_segments.txt", listContent);
    await runFfmpeg({
      args: [
        "-f", "concat", "-safe", "0", "-i", "concat_segments.txt",
        "-c", "copy",
        "-movflags", "+faststart",
        outFile,
      ],
      cwd: params.io.tmpDir,
      outputDurationSec: total,
      outputPaths: [outFile],
    });
    await params.io.log(`Assemblage par concaténation directe (${params.segmentFiles.length} segments, coupes franches — aucun ré-encodage).`);
    return { file: outFile, durationSec: round2(total) };
  }

  const built = buildTransitionFfmpegArgs({
    segmentFiles: params.segmentFiles,
    durations,
    transitions: params.plan.transitions,
    outFile,
    fps: params.plan.fps,
    height: dims.height,
  });
  if (!built) {
    return { file: params.segmentFiles[0], durationSec: round2(total) };
  }
  await runFfmpeg({
    args: built.args,
    cwd: params.io.tmpDir,
    outputDurationSec: built.expectedDurationSec,
    outputPaths: [outFile],
  });
  await params.io.log(`Transitions appliquées (${params.plan.transitions.length} frontières, ${round2(built.expectedDurationSec)} s attendues).`);
  return { file: outFile, durationSec: built.expectedDurationSec };
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
  // Task 106-b — MUSIQUE PAR SCÈNE : lit unique (historique, chemin
  // inchangé) ou lits multiples posés à leurs fenêtres de mood avec
  // crossfade aux jonctions (musicFiles → chemin dédié du planner).
  const musicFiles: MusicTrackInput[] = [];
  let musicFile: string | undefined;
  if (mix.music.length === 1) {
    const musicAsset = await params.io.getAsset(mix.music[0].assetId);
    if (musicAsset) musicFile = await params.io.materialize(musicAsset, "music_bed.wav");
  } else if (mix.music.length > 1) {
    for (const item of mix.music) {
      const asset = await params.io.getAsset(item.assetId);
      if (!asset) continue; // asset introuvable : lit sauté (QC signalera)
      musicFiles.push({
        file: await params.io.materialize(asset, `music_${item.id}.wav`),
        startSec: item.startSec,
        durationSec: item.durationSec,
        volume: item.volume,
        fadeInSec: item.fadeInSec,
        fadeOutSec: item.fadeOutSec,
      });
    }
  }

  const args = buildAudioMixFfmpegArgs({
    narrationFiles,
    musicFile,
    musicVolume: mix.music[0]?.volume ?? 0.6,
    musicFiles: musicFiles.length > 0 ? musicFiles : undefined,
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
  const dims = dimensionsFor(params.plan.aspectRatio, params.plan.resolution);
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
    // Task 120 — veryfast + CRF adapté à la résolution + threads auto
    // (stream copy quand aucun sous-titre n'est brûlé : zéro ré-encodage).
    ...(params.burnAssFileName
      ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(crfForHeight(dims.height)), "-pix_fmt", "yuv420p", "-threads", "0"]
      : ["-c:v", "copy"]),
    ...(params.audioFile ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
    "-shortest",
    // Task 120 — lecture progressif (diffusion) : métadonnées en tête du mp4.
    "-movflags", "+faststart",
    outFile,
  ];
  await runFfmpeg({
    args,
    cwd: params.io.tmpDir,
    outputDurationSec: params.durationSec,
    outputPaths: [outFile],
  });
  await params.io.log("Master assemblé (vidéo + audio + sous-titres)." + (params.burnAssFileName ? "" : " — flux vidéo copié sans ré-encodage."));
  return outFile;
}

/**
 * Résout la durée de référence du timeout FFmpeg d'un export dérivé
 * (Task 106-b — EXPORT TIMEOUT RÉEL).
 *
 * Ordre de priorité :
 *   1. `paramSec` — durée déjà connue par l'appelant (probe du master à
 *      l'étape finalize / plan.estimatedSec) ;
 *   2. `probedSec` — durée réelle mesurée par ffprobe sur le master local ;
 *   3. repli historique : 60 s (comportement d'origine, master illisible).
 *
 * Auparavant la valeur était codée dur à 60 → timeout FFmpeg ≈ 4 min
 * (ffmpegTimeoutSec(60)) et les exports de vidéos longues échouaient en
 * TIMEOUT alors que le rendu était parfaitement sain.
 */
export function resolveExportTimeoutSec(paramSec: number | undefined, probedSec: number | undefined): number {
  const isValid = (n: number | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0;
  if (isValid(paramSec)) return paramSec;
  if (isValid(probedSec)) return probedSec;
  return 60;
}

/** Produit un format dérivé (9:16, 1:1…) depuis le master. */
export async function renderExportFormat(params: {
  io: EngineIo;
  masterFile: string;
  target: string;
  assFileName?: string;
  /** Durée réelle du master si déjà connue de l'appelant (alimente le timeout). */
  outputDurationSec?: number;
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
  // Task 106-b — durée réelle du master : paramètre explicite, sinon sonde
  // ffprobe locale (aucune URL réseau — fichier tmp déjà matérialisé),
  // sinon repli historique 60 s. Le timeout FFmpeg suit donc la durée
  // réelle au lieu d'un plafond arbitraire.
  let probedSec: number | undefined;
  if (
    !(typeof params.outputDurationSec === "number" && Number.isFinite(params.outputDurationSec) && params.outputDurationSec > 0)
  ) {
    const probe = await probeMedia(params.masterFile, params.io.tmpDir).catch(() => null);
    probedSec = probe?.durationSec;
  }
  const outputDurationSec = resolveExportTimeoutSec(params.outputDurationSec, probedSec);
  await runFfmpeg({
    args,
    cwd: params.io.tmpDir,
    outputDurationSec,
    outputPaths: [outFile],
  });
  return outFile;
}

function targetOf(target: string): string {
  return target;
}

/** Upload le master vers R2 et renvoie la clé. */
export async function uploadMaster(params: {
  io: EngineIo;
  masterFile: string;
  projectId: string;
  jobId: string;
  /**
   * Task 120 — QC ALLÉGÉE : métadonnées ffprobe DÉJÀ sondées par l'appelant
   * (cache job posé à la QC) — évite une re-sonde du MÊME fichier au
   * finalize. Absentes/partielles → sonde locale de repli.
   */
  probe?: MediaProbe;
}): Promise<{ r2Key: string; sizeBytes: number; durationSec: number; width: number; height: number }> {
  const body = await readFile(params.masterFile);
  const r2Key = await params.io.uploadRender(`renders/${params.jobId}/master.mp4`, body, "renders");
  const probe =
    params.probe ??
    (await probeMedia(params.masterFile, params.io.tmpDir).catch(
      () => ({}) as MediaProbe,
    ));
  const sizeBytes = (await stat(params.masterFile)).size;
  return {
    r2Key,
    sizeBytes,
    durationSec: probe.durationSec ?? 0,
    width: probe.width ?? 0,
    height: probe.height ?? 0,
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
