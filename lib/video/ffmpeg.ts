import "server-only";

/**
 * GEN3IA VIDEO AGENT — exécution FFmpeg/ffprobe sandboxée.
 *
 * Garde-fous appliqués à CHAQUE commande (spec §28) :
 * - arguments de bac à sable imposés (-nostdin, protocol_whitelist file,pipe,
 *   max_alloc) : aucun accès réseau possible, jamais d'URL distante ;
 * - répertoire de travail dédié au job (tmp), chemins résolus vérifiés ;
 * - timeout par commande (annulation) ;
 * - plafond de taille de sortie (vérifié après exécution) ;
 * - binaires configurables (VIDEO_FFMPEG_PATH / VIDEO_FFPROBE_PATH).
 */

import { spawn } from "node:child_process";
import { stat, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  FFMPEG_BINARY,
  FFPROBE_BINARY,
  FFMPEG_SANDBOX_ARGS,
  ffmpegTimeoutSec,
  VIDEO_LIMITS,
} from "@/lib/video/security";
import type { MediaProbe } from "@/lib/video/types";

export class FfmpegError extends Error {
  code: "TIMEOUT" | "EXIT_NONZERO" | "SPAWN_ERROR" | "OUTPUT_TOO_LARGE" | "NOT_INSTALLED";
  stderr?: string;

  constructor(code: FfmpegError["code"], message: string, stderr?: string) {
    super(message);
    this.name = "FfmpegError";
    this.code = code;
    this.stderr = stderr;
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
}

async function runCommand(
  binary: string,
  args: string[],
  options: { cwd: string; timeoutSec: number; onLine?: (line: string) => void },
): Promise<RunResult> {
  return new Promise((accept, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    let child;
    try {
      child = spawn(binary, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new FfmpegError("SPAWN_ERROR", `Impossible de lancer ${binary} : ${String(error)}`));
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new FfmpegError("TIMEOUT", `Commande ${binary} annulée après ${options.timeoutSec}s (timeout).`));
    }, options.timeoutSec * 1000);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 4_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 4_000_000) stderr = stderr.slice(-1_000_000);
      if (options.onLine) text.split(/\r?\n/).forEach((l) => l && options.onLine!(l));
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new FfmpegError("SPAWN_ERROR", `Erreur de lancement : ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) accept({ stdout, stderr });
      else reject(new FfmpegError("EXIT_NONZERO", `${binary} a échoué (code ${code})`, stderr.slice(-4000)));
    });
  });
}

/** Vérifie que le chemin reste dans le répertoire du job (anti-traversée). */
export function assertInsideDir(dir: string, target: string): void {
  const resolved = resolve(target);
  if (!resolved.startsWith(resolve(dir))) {
    throw new FfmpegError("SPAWN_ERROR", `Chemin hors du bac à sable : ${target}`);
  }
}

/**
 * Exécute FFmpeg avec le bac à sable complet.
 * `args` ne doit contenir AUCUN chemin absolu hors `cwd` (vérifié).
 */
export async function runFfmpeg(params: {
  args: string[];
  cwd: string;
  outputDurationSec: number;
  outputPaths?: string[];
  onProgress?: (line: string) => void;
}): Promise<RunResult> {
  const allArgs = [...FFMPEG_SANDBOX_ARGS, ...params.args];
  for (const arg of allArgs) {
    if (typeof arg === "string" && arg.startsWith("/")) {
      assertInsideDir(params.cwd, arg);
    }
  }
  const result = await runCommand(FFMPEG_BINARY, allArgs, {
    cwd: params.cwd,
    timeoutSec: ffmpegTimeoutSec(params.outputDurationSec),
    onLine: params.onProgress,
  });
  for (const out of params.outputPaths ?? []) {
    assertInsideDir(params.cwd, out);
    try {
      const info = await stat(out);
      if (info.size > VIDEO_LIMITS.maxRenderBytes) {
        throw new FfmpegError("OUTPUT_TOO_LARGE", "Sortie de rendu au-delà du plafond de taille.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FfmpegError("EXIT_NONZERO", `Sortie attendue absente : ${out}`);
      }
      throw error;
    }
  }
  return result;
}

/** Sonde ffprobe — métadonnées réelles des médias (durée, dimensions, audio). */
export async function probeMedia(filePath: string, cwd: string): Promise<MediaProbe> {
  assertInsideDir(cwd, filePath);
  const result = await runCommand(
    FFPROBE_BINARY,
    [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    { cwd, timeoutSec: 60 },
  );
  const parsed = JSON.parse(result.stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      duration?: string;
    }>;
  };
  const video = parsed.streams?.find((s) => s.codec_type === "video");
  const audio = parsed.streams?.find((s) => s.codec_type === "audio");
  const fpsFromRate = video?.r_frame_rate?.includes("/") ? parseFps(video.r_frame_rate) : undefined;
  return {
    durationSec: toNumber(parsed.format?.duration) ?? toNumber(video?.duration),
    width: video?.width,
    height: video?.height,
    fps: fpsFromRate,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name,
    videoCodec: video?.codec_name,
  };
}

function toNumber(value?: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseFps(rate: string): number | undefined {
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return undefined;
  const fps = num / den;
  return Number.isFinite(fps) ? Math.round(fps * 100) / 100 : undefined;
}

/** Vérifie la disponibilité des binaires (diagnostic worker). */
export async function checkFfmpegAvailable(): Promise<{ ffmpeg: boolean; ffprobe: boolean; version?: string }> {
  try {
    const result = await runCommand(FFMPEG_BINARY, ["-version"], { cwd: "/tmp", timeoutSec: 15 });
    let ffprobe = false;
    try {
      await runCommand(FFPROBE_BINARY, ["-version"], { cwd: "/tmp", timeoutSec: 15 });
      ffprobe = true;
    } catch {
      ffprobe = false;
    }
    const version = result.stdout.split("\n")[0]?.trim();
    return { ffmpeg: true, ffprobe, version };
  } catch {
    return { ffmpeg: false, ffprobe: false };
  }
}

/** Nettoyage d'un répertoire tmp de job (annulation / fin de job). */
export async function cleanupTmpDir(tmpDir: string): Promise<void> {
  await rm(tmpDir, { recursive: true, force: true });
}
