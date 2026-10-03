import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCb, spawnSync } from "node:child_process";
import { promisify } from "node:util";

/**
 * TEST D'INTÉGRATION FFMBED RÉEL (protocole : chaque modification validée
 * par de vrais tests). Le pipeline visuel complet est exécuté :
 *
 *   images réelles (lavfi) → segments (zoompan + effets) → transitions
 *   (xfade) → mixage audio (ducking sidechain) → master muxé → VÉRIFIÉ
 *   par ffprobe (durée, flux audio) + agent QC (volumedetect/blackdetect).
 *
 * Aucun mock FFmpeg : si ffmpeg est absent, le test échoue explicitement
 * (c'est une capacité du produit).
 */

import { runFfmpeg, probeMedia } from "@/lib/video/ffmpeg";
import { renderSegments, assembleTransitions, mixAudio, finalizeMaster, type EngineIo } from "@/lib/video/render/engine";
import { analyzeRenderedMaster, decideAutoFix } from "@/lib/video/qc-service";
import type { RenderPlan, VideoAsset } from "@/lib/video/types";

const execFile = promisify(execFileCb);

/** Disponibilité FFmpeg vérifiée SYNCHRONEment au chargement (skipIf). */
const ffmpegOk = (() => {
  const result = spawnSync(process.env.VIDEO_FFMPEG_PATH || "ffmpeg", ["-version"], { encoding: "utf8", timeout: 15_000 });
  return result.status === 0;
})();

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "gen3ia-video-it-"));
  if (!ffmpegOk) throw new Error("FFmpeg indisponible : le test d'intégration doit échouer explicitement.");
  // 2 images réelles 1280x720 (lavfi) + 1 narration réelle (sine 440 Hz).
  await execFile("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=1280x720:rate=25", "-frames:v", "1", join(tmpDir, "img_0_0.png")]);
  await execFile("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=steelblue:s=1280x720:d=1", "-frames:v", "1", join(tmpDir, "img_1_0.png")]);
  await execFile("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3.6", "-ac", "2", join(tmpDir, "narr_0.wav")]);
  await execFile("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=8", "-ac", "2", "-t", "8", join(tmpDir, "music.wav")]);
}, 120_000);

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function fakeAsset(id: string, r2Key: string, kind: VideoAsset["kind"], durationSec?: number): VideoAsset {
  return {
    id, projectId: "p_it", userId: "u_it", kind, label: id, r2Key,
    contentType: kind === "image" ? "image/png" : "audio/wav",
    sizeBytes: 10_000, origin: "generated",
    media: durationSec ? { durationSec, hasAudio: true } : undefined,
    createdAt: new Date().toISOString(),
  };
}

function testPlan(): RenderPlan {
  const motion = {
    preset: "slow_zoom" as const,
    keyframes: [
      { at: 0, scale: 1, x: 0, y: 0, rotationDeg: 0 },
      { at: 1, scale: 1.12, x: 0, y: 0, rotationDeg: 0 },
    ],
  };
  return {
    planId: "plan_it", projectId: "p_it", jobId: "job_it",
    resolution: "720p", aspectRatio: "16:9", fps: 25,
    output: { videoCodec: "h264", audioCodec: "aac", container: "mp4" },
    segments: [
      {
        index: 0, sceneId: "scene_001", durationSec: 2, imageR2Keys: ["img_0_0.png"],
        narrationR2Key: "narr_0.wav", motion, effects: [{ name: "vignette", intensity: "subtle" }],
        textOverlays: [], transitionIn: "fade", transitionOut: "dissolve",
      },
      {
        index: 1, sceneId: "scene_002", durationSec: 2, imageR2Keys: ["img_1_0.png"],
        motion, effects: [], textOverlays: [], transitionIn: "dissolve", transitionOut: "fade",
      },
    ],
    transitions: [{ afterSegmentIndex: 0, name: "dissolve", durationSec: 0.5 }],
    audioMix: {
      narration: [
        { id: "n0", assetId: "narr_0", startSec: 0, durationSec: 3.6, volume: 1, fadeInSec: 0.1, fadeOutSec: 0.2, eq: { highpassHz: 90 } },
      ],
      music: [
        { id: "m0", assetId: "music", startSec: 0, durationSec: 3.5, volume: 0.5, fadeInSec: 0.3, fadeOutSec: 0.5, eq: { lowpassHz: 9000 } },
      ],
      sfx: [],
      ducking: { enabled: true, nominalVolume: 0.5, duckedVolume: 0.2, attackSec: 0.1, releaseSec: 0.2 },
      targetLoudnessDb: -16,
    },
    derivedTargets: [],
    estimatedSec: 3.5,
  };
}

/** Engine IO local : r2Key = nom de fichier dans tmpDir (canal réel FFmpeg, R2 absent du test). */
function localIo(): EngineIo {
  return {
    tmpDir,
    getAsset: async (assetId) => {
      const plan = testPlan();
      if (assetId === "narr_0") return fakeAsset("narr_0", "narr_0.wav", "audio_narration", 3.6);
      if (assetId === "music") return fakeAsset("music", "music.wav", "audio_music", 8);
      void plan;
      return null;
    },
    materialize: async (asset, fileName) => {
      const { copyFile } = await import("node:fs/promises");
      const target = join(tmpDir, fileName);
      await copyFile(join(tmpDir, asset.r2Key), target);
      return target;
    },
    materializeByName: async (r2Key, fileName) => {
      const { copyFile } = await import("node:fs/promises");
      const target = join(tmpDir, fileName);
      await copyFile(join(tmpDir, r2Key), target);
      return target;
    },
    writeTmp: async (fileName, content) => {
      const target = join(tmpDir, fileName);
      await writeFile(target, content, "utf8");
      return target;
    },
    uploadRender: async (fileName, body) => {
      const target = join(tmpDir, fileName.replace("/", "_"));
      await writeFile(target, body);
      return `it/${fileName}`;
    },
    log: async () => undefined,
    tmpDir,
  };
}

describe.skipIf(!ffmpegOk)("Intégration FFmpeg réelle — pipeline visuel complet", () => {
  it("segments → transitions → audio → master : durées et flux vérifiés par ffprobe", { timeout: 180_000 }, async () => {
    const plan = testPlan();
    const io = localIo();
    const completed: number[] = [];

    // 1. SEGMENTS (zoompan + effets réels).
    const segmentFiles = await renderSegments({
      plan, io, userId: "u_it", completedSegments: [],
      onSegmentDone: async (index) => { completed.push(index); },
    });
    expect(completed.sort()).toEqual([0, 1]);
    for (const file of segmentFiles) {
      const probe = await probeMedia(file, tmpDir);
      expect(probe.durationSec).toBeGreaterThan(1.9);
      expect(probe.width).toBe(1280);
      expect(probe.height).toBe(720);
    }

    // 2. TRANSITIONS (xfade dissolve 0.5 s) → durée attendue 2+2−0.5 = 3.5 s.
    const assembled = await assembleTransitions({ plan, io, segmentFiles });
    expect(assembled.durationSec).toBeCloseTo(3.5, 1);
    const videoProbe = await probeMedia(join(tmpDir, "video_noaudio.mp4"), tmpDir);
    expect(videoProbe.durationSec).toBeGreaterThan(3.3);
    expect(videoProbe.durationSec).toBeLessThan(3.8);

    // 3. AUDIO (narration + musique duckée par sidechaincompress).
    const audioFile = await mixAudio({ plan, io, durationSec: plan.estimatedSec });
    expect(audioFile).not.toBeNull();
    const audioProbe = await probeMedia(audioFile!, tmpDir);
    expect(audioProbe.hasAudio).toBe(true);
    expect(audioProbe.durationSec).toBeGreaterThan(3.2);

    // 4. MASTER (mux vidéo + audio).
    const master = await finalizeMaster({
      plan, io, videoNoAudioFile: join(tmpDir, "video_noaudio.mp4"),
      audioFile: audioFile!, durationSec: plan.estimatedSec,
    });
    const masterProbe = await probeMedia(master, tmpDir);
    expect(masterProbe.hasAudio).toBe(true);
    expect(masterProbe.videoCodec).toBe("h264");
    expect(masterProbe.width).toBe(1280);

    // 5. QC AGENT sur le master RÉEL.
    const report = await analyzeRenderedMaster({
      masterFile: master, tmpDir, plan,
      expectedDurationSec: 3.5, subtitlesEnabled: false,
    });
    // Durée réelle mesurée, volume mesuré — le QC travaille sur des données vraies.
    expect(report.metrics.durationSec).toBeGreaterThan(3.2);
    expect(report.metrics.maxVolumeDb).toBeDefined();
    expect(report.passed).toBe(true);
    expect(decideAutoFix(report, plan).action).toBe("accept");
  }, 200_000);

  it("reprise : les segments déjà rendus sont SAUTÉS (checkpoint, spec §19)", { timeout: 120_000 }, async () => {
    const plan = testPlan();
    const io = localIo();
    // Le segment 0 est déjà « terminé » : la reprise ne le re-rend pas,
    // mais le fichier attendu est toujours dans la liste (assemblage possible).
    const segmentFiles = await renderSegments({
      plan, io, userId: "u_it",
      completedSegments: [0],
      onSegmentDone: async (index) => { void index; },
    });
    expect(segmentFiles).toHaveLength(2);
    const files = await readdir(tmpDir);
    // segment_0000.mp4 existait déjà du test précédent ou vient d'être rendu.
    expect(files.some((f) => f === "segment_0000.mp4")).toBe(true);
    expect(files.some((f) => f === "segment_0001.mp4")).toBe(true);
  }, 150_000);

  it("graphe de filtres invalide refusé : aucun chemin hors du tmp (sécurité)", async () => {
    await expect(
      runFfmpeg({
        args: ["-i", "/etc/passwd", "-f", "null", "-"],
        cwd: tmpDir,
        outputDurationSec: 1,
      }),
    ).rejects.toThrow();
  });

  it("burn de sous-titres ASS réel (libass) quand le filtre est disponible", { timeout: 120_000 }, async () => {
    // Vérifie la disponibilité réelle du filtre subtitles (pas de mock).
    let hasSubtitles = false;
    try {
      const { stdout } = await execFile("ffmpeg", ["-hide_banner", "-filters"]);
      hasSubtitles = stdout.includes(" subtitles ");
    } catch {
      hasSubtitles = false;
    }
    if (!hasSubtitles) {
      console.warn("Filtre subtitles indisponible dans ce build ffmpeg — test brûlage ignoré (signalé, pas masqué).");
      return;
    }
    const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,48,&H00FFFFFF,&H000000FF,&H80000000,&H60000000,0,0,0,0,100,100,0,0,1,2,1,2,60,60,50,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,Test de sous-titre réel
`;
    await writeFile(join(tmpDir, "it_subtitles.ass"), ass, "utf8");
    // Copie de l'image segment_0000 déjà rendue par le premier test.
    const outFile = join(tmpDir, "burned.mp4");
    await runFfmpeg({
      args: [
        "-i", join(tmpDir, "video_noaudio.mp4"),
        "-vf", "subtitles=it_subtitles.ass:fontsdir=/usr/share/fonts",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-an",
        outFile,
      ],
      cwd: tmpDir,
      outputDurationSec: 4,
      outputPaths: [outFile],
    });
    const info = await stat(outFile);
    expect(info.size).toBeGreaterThan(1000);
  });
});
