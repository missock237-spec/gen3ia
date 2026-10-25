import "server-only";

/**
 * FUSION CENTRALE DE L'ESSAIM MÉDIA — « associer les signaux ».
 *
 * Les fragments WebGPU remontent à l'IA centrale (PNG de keyframes,
 * WAV de segments vocaux). Ce module les ASSOCIE en une œuvre finale :
 *  - vidéo → fondus enchaînés xfade (FFmpeg sandboxé, binaire ffmpeg-static)
 *    → MP4 H.264 24 img/s ;
 *  - voix  → concaténation PCM avec micro-fondu d'égalité de puissance
 *    (60 ms) → un seul WAV fluide, sans clic entre segments ;
 *  - image → passage direct (1 fragment).
 *
 * `concaténerWav` et `construireGrapheXfade` sont PURES : testées.
 */

import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FfmpegError, runFfmpeg, cleanupTmpDir } from "@/lib/video/ffmpeg";
import { BORNES_ESSAIM } from "./types";
import { concaténerWav } from "./wav";

export { concaténerWav }; // ré-export partagé (serveur + navigateur)

/* ---------------------------------------------------------- vidéo (xfade) --- */

/** Construit le graphe de filtres xfade (pur — testé, miroir video-engine). */
export function construireGrapheXfade(n: number, duréeKf: number, fondu: number): string {
  if (n <= 1) return "[0:v]fps=24,format=yuv420p[vfinal]";
  const parts: string[] = [];
  let entrée = "[0:v]";
  for (let k = 1; k < n; k++) {
    const offset = Math.max(0, duréeKf * k - fondu * (k - 1) - fondu).toFixed(2);
    const sortie = k === n - 1 ? "[vchaîne]" : `[v${k}]`;
    parts.push(
      `${entrée}[${k}:v]xfade=transition=fade:duration=${fondu}:offset=${offset}${sortie}`,
    );
    entrée = `[v${k}]`;
  }
  parts.push("[vchaîne]fps=24,format=yuv420p[vfinal]");
  return parts.join(";");
}

export interface OptionsFusionVidéo {
  duréeParKeyframe?: number;
  fondu?: number;
  onProgress?: (ligne: string) => void;
}

/**
 * ASSOCIATION DES KEYFRAMES — N PNG → MP4 H.264 fondus enchaînés, via le
 * FFmpeg sandboxé de la plateforme (lib/video/ffmpeg — binaire ffmpeg-static,
 * protocol_whitelist file,pipe, plafonds de durée/taille). Lève FfmpegError
 * en cas d'échec : la route renverra un échec HONNÊTE, jamais un faux MP4.
 */
export async function fusionnerVidéoEssaim(
  pngs: Uint8Array[],
  opts: OptionsFusionVidéo = {},
): Promise<Uint8Array> {
  if (pngs.length === 0) throw new Error("Aucune keyframe à fusionner.");
  if (pngs.length === 1) return pngs[0];
  const duréeKf = opts.duréeParKeyframe ?? 1.6;
  const fondu = opts.fondu ?? 0.5;
  const tmp = await mkdtemp(join(tmpdir(), "gen3ia-essaim-"));
  try {
    for (let k = 0; k < pngs.length; k++) {
      await writeFile(join(tmp, `kf_${k}.png`), pngs[k]);
    }
    const args = [
      ...pngs.flatMap((_, k) => [
        "-loop", "1", "-t", String(duréeKf), "-i", `kf_${k}.png`,
      ]),
      "-filter_complex", construireGrapheXfade(pngs.length, duréeKf, fondu),
      "-map", "[vfinal]",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "out.mp4",
    ];
    await runFfmpeg({
      args,
      cwd: tmp,
      outputDurationSec: duréeKf * pngs.length,
      outputPaths: [join(tmp, "out.mp4")],
      onProgress: opts.onProgress,
    });
    return new Uint8Array(await readFile(join(tmp, "out.mp4")));
  } catch (error) {
    if (error instanceof FfmpegError) throw error;
    throw new FfmpegError(
      "EXIT_NONZERO",
      `Fusion vidéo d'essaim échouée : ${error instanceof Error ? error.message : "erreur"}`,
    );
  } finally {
    await cleanupTmpDir(tmp).catch(() => rm(tmp, { recursive: true, force: true }));
  }
}

/* ------------------------------------------------------------- complétion --- */

export interface OeuvreFusionnée {
  octets: Uint8Array;
  mime: "image/png" | "audio/wav" | "video/mp4";
  extension: "png" | "wav" | "mp4";
}

/** Dispatch de fusion selon le kind (image = passage direct). */
export async function fusionnerOeuvre(
  kind: "image" | "voice" | "video",
  résultats: Map<number, Uint8Array>,
  opts: OptionsFusionVidéo = {},
): Promise<OeuvreFusionnée> {
  const triés = [...résultats.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  if (triés.length === 0) throw new Error("Aucun fragment reçu — fusion impossible.");
  if (kind === "image") {
    return { octets: triés[0], mime: "image/png", extension: "png" };
  }
  if (kind === "voice") {
    return { octets: concaténerWav(triés), mime: "audio/wav", extension: "wav" };
  }
  const vidéo = await fusionnerVidéoEssaim(triés, opts);
  return { octets: vidéo, mime: "video/mp4", extension: "mp4" };
}

/** Garde-fou final de taille (parité webgpu-complete). */
export function vérifierTaille(octets: Uint8Array): void {
  if (octets.byteLength > BORNES_ESSAIM.tailleOeuvreMax) {
    throw new Error(`Œuvre trop volumineuse (${Math.round(octets.byteLength / 1024 / 1024)} Mo > 25 Mo).`);
  }
}
