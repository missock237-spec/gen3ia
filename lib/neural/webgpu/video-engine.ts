"use client";

/**
 * MOTEUR VIDÉO WEBGPU — keyframes photoréalistes → MP4, 100 % local.
 *
 * Stratégie honnête de génération vidéo réaliste côté navigateur :
 *  1. 3 à 4 KEYFRAMES photoréalistes générées par le moteur SD WebGPU
 *     (graines liées pour la continuité chromatique) ;
 *  2. ASSEMBLAGE ffmpeg.wasm : fondus enchaînés (xfade), 24 img/s, H.264
 *     yuv420p — un vrai fichier MP4 lisible partout.
 *
 * Aucun modèle vidéo lourd (CogVideoX ≈ 5 Md de paramètres) ne tourne dans
 * un navigateur en 2026 : la décomposition keyframes + transitions est la
 * voie réellement exécutable sur le GPU utilisateur, cohérente avec le
 * pipeline serveur lib/video (mêmes principes, mêmes formats).
 */

import { générerImageWebGpu } from "./image-engine";

export interface OptionsVidéoWebGpu {
  /** Brief de scène (FR ou EN). */
  prompt: string;
  /** Nombre de keyframes (3–5). */
  keyframes?: number;
  /** Durée d'affichage de chaque keyframe avant fondu (s). */
  duréeParKeyframe?: number;
  /** Ratio d'aspect du rendu. */
  ratio?: string;
  seed?: number;
  onProgress?: (info: { étape: string; pourcent: number }) => void;
}

export interface RésultatVidéoWebGpu {
  blob: Blob;
  nbKeyframes: number;
  duréeSecondes: number;
  duréeMs: number;
  moteur: "sd-webgpu + ffmpeg.wasm";
}

/** Charge ffmpeg.wasm une seule fois (core ST — pas besoin de SAB). */
interface FfmpegMin {
  run: (args: string[]) => Promise<void>;
  writeFile: (n: string, d: Uint8Array) => Promise<void>;
  readFile: (n: string) => Promise<Uint8Array>;
}
let ffmpegChargé: Promise<FfmpegMin | null> | null = null;

async function chargerFfmpeg(): Promise<FfmpegMin | null> {
  if (ffmpegChargé) return ffmpegChargé;
  ffmpegChargé = (async () => {
    try {
      const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
        import("@ffmpeg/ffmpeg"),
        import("@ffmpeg/util"),
      ]);
      const ffmpeg = new FFmpeg();
      const base = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";
      await ffmpeg.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
      });
      return ffmpeg as unknown as FfmpegMin;
    } catch {
      return null; // ffmpeg.wasm indisponible (CSP stricte, SAB absent…) : repli GIF/frames
    }
  })();
  return ffmpegChargé;
}

/**
 * Génère la vidéo : keyframes SD WebGPU + assemblage MP4 fondus.
 * Si ffmpeg.wasm échoue, retourne la première keyframe comme image de
 * secours (jamais de faux MP4) — le champ blob porte le bon type MIME.
 */
export async function générerVidéoWebGpu(opts: OptionsVidéoWebGpu): Promise<RésultatVidéoWebGpu> {
  const début = Date.now();
  const nbKeyframes = Math.min(Math.max(opts.keyframes ?? 3, 3), 5);
  const duréeKf = opts.duréeParKeyframe ?? 1.4;
  const graineBase = opts.seed ?? Date.now();

  // 1) Keyframes photoréalistes (graines liées : continuité visuelle).
  const pngs: Uint8Array[] = [];
  for (let k = 0; k < nbKeyframes; k++) {
    const res = await générerImageWebGpu({
      prompt: opts.prompt,
      ratio: opts.ratio ?? "16:9",
      seed: graineBase + k * 17,
      onProgress: (info) =>
        opts.onProgress?.({
          étape: `Keyframe ${k + 1}/${nbKeyframes} — ${info.étape}`,
          pourcent: Math.round(((k + (info.pourcent / 100)) / nbKeyframes) * 80),
        }),
    });
    pngs.push(new Uint8Array(await res.blob.arrayBuffer()));
  }

  // 2) Assemblage MP4 (xfade) via ffmpeg.wasm.
  opts.onProgress?.({ étape: "Assemblage MP4 (fondus, 24 img/s)…", pourcent: 85 });
  const ffmpeg = await chargerFfmpeg();
  if (ffmpeg) {
    try {
      for (let k = 0; k < pngs.length; k++) {
        await ffmpeg.writeFile(`kf_${k}.png`, pngs[k]);
      }
      // Filtre xfade en chaîne : offset cumulé = duréeKf·(k+1) − fondu·k.
      const fondu = 0.5;
      let filtre = "";
      let offsets = "";
      for (let k = 1; k < pngs.length; k++) {
        const offset = duréeKf * k - fondu * (k - 1);
        offsets += `${offset.toFixed(2)} `;
        filtre += k === 1 ? "[0][1]xfade" : `[v${k - 1}][${k}]xfade`;
        filtre += k === pngs.length - 1 ? `[v${k}]` : `[v${k}]`;
        if (k < pngs.length - 1) filtre += ";";
      }
      // Recompose proprement avec offsets (xfade exige offset=offsets[k-1]).
      const args = [
        ...pngs.flatMap((_, k) => ["-loop", "1", "-t", String(duréeKf), "-i", `kf_${k}.png`]),
        "-filter_complex",
        construireXfade(pngs.length, duréeKf, fondu),
        "-map", `[vfinal]`,
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "out.mp4",
      ];
      void filtre;
      void offsets;
      await ffmpeg.run(args);
      const data = await ffmpeg.readFile("out.mp4");
      opts.onProgress?.({ étape: "Vidéo prête (100 % locale).", pourcent: 100 });
      return {
        blob: new Blob([data.slice().buffer as ArrayBuffer], { type: "video/mp4" }),
        nbKeyframes,
        duréeSecondes: duréeKf * pngs.length,
        duréeMs: Date.now() - début,
        moteur: "sd-webgpu + ffmpeg.wasm",
      };
    } catch {
      // Assemblage raté : repli keyframe unique (honnête, pas de faux MP4).
    }
  }

  opts.onProgress?.({ étape: "MP4 indisponible — keyframe livrée à la place.", pourcent: 100 });
  return {
    blob: new Blob([pngs[0].slice().buffer as ArrayBuffer], { type: "image/png" }),
    nbKeyframes: 1,
    duréeSecondes: 0,
    duréeMs: Date.now() - début,
    moteur: "sd-webgpu + ffmpeg.wasm",
  };
}

/** Construit le graphe de filtres xfade (n keyframes, durée d, fondu f). */
function construireXfade(n: number, d: number, f: number): string {
  const parts: string[] = [];
  let entréePrécédente = "[0]";
  for (let k = 1; k < n; k++) {
    const offset = (d * k - f * (k - 1)).toFixed(2);
    const sortie = k === n - 1 ? "[vchaîne]" : `[v${k}]`;
    parts.push(`${entréePrécédente}[${k}]xfade=transition=fade:duration=${f}:offset=${offset}${sortie}`);
    entréePrécédente = `[v${k}]`;
  }
  if (n === 1) {
    return "[0]scale=640:-2,fps=24,format=yuv420p[vfinal]";
  }
  parts.push("[vchaîne]scale=640:-2,fps=24,format=yuv420p[vfinal]");
  return parts.join(";");
}
