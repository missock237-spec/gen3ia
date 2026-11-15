import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 18 : Long Video Engine (spec §17).
 *
 * Un système limité à 1-2 minutes est inacceptable : le Long Video Engine
 * prévoit 30 s → 1 h (et au-delà) SANS tout charger en mémoire :
 *
 * - le plan de rendu est segmenté (1 segment = 1 scène) ;
 * - l'assemblage des transitions se fait par PASSES RÉCURSIVES : n
 *   segments → n/2 fichiers fusionnés (xfade, offsets exacts, 2 entrées
 *   par commande = mémoire bornée) → … → 1 master. Toutes les transitions
 *   sont préservées ; chaque passe est un CHECKPOINT : après un crash à
 *   73 %, l'état est restauré DEPUIS LE DISQUE (fichiers des passes
 *   précédentes + durées réelles ffprobe) et la fusion reprend où elle
 *   s'était arrêtée ;
 * - les chapitres sont calculés depuis le scénario pour la progression
 *   (MASTER PROJECT : Chapter 1 — 00:00–08:00 …).
 */

import fsp from "node:fs/promises";
import { join } from "node:path";
import type { RenderPlan, VideoProject, VideoScript } from "@/lib/video/types";
import { runFfmpeg, probeMedia } from "@/lib/video/ffmpeg";
import { xfadeTransitionName } from "@/lib/video/effects-service";
import type { EngineIo } from "@/lib/video/render/engine";
import { formatTimecode } from "@/lib/video/types";

// ────────────────────────────────────────────────────────────────────────────
// Chapitres
// ────────────────────────────────────────────────────────────────────────────

export interface ChapterWindow {
  chapterId: string;
  title: string;
  startSec: number;
  endSec: number;
  sceneCount: number;
}

/** Fenêtres temporelles des chapitres (progression, UI, journal). */
export function computeChapterWindows(script: VideoScript): ChapterWindow[] {
  const windows: ChapterWindow[] = [];
  for (const chapter of script.chapters) {
    const scenes = script.scenes.filter((s) => chapter.sceneIds.includes(s.id));
    if (scenes.length === 0) continue;
    const startSec = scenes[0].startSec;
    const endSec = scenes[scenes.length - 1].startSec + scenes[scenes.length - 1].durationSec;
    windows.push({ chapterId: chapter.id, title: chapter.title, startSec, endSec, sceneCount: scenes.length });
  }
  return windows;
}

/** Résumé lisible des chapitres (journal directeur, UI). */
export function describeChapters(project: VideoProject): string {
  if (!project.script) return "Aucun scénario.";
  return computeChapterWindows(project.script)
    .map((c) => `${c.title} — ${formatTimecode(c.startSec)} → ${formatTimecode(c.endSec)} (${c.sceneCount} scènes)`)
    .join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// Assemblage récursif avec reprise sur disque
// ────────────────────────────────────────────────────────────────────────────

interface MergeNode {
  file: string;
  durationSec: number;
  firstIndex: number; // index du segment de gauche (transitions[afterSegmentIndex])
  lastIndex: number;
}

/** Simule l'arbre de fusion jusqu'à `startPass` (noms de fichiers déterministes). */
function simulateMapping(totalSegments: number, startPass: number): Array<{ firstIndex: number; lastIndex: number; file: string }> {
  let nodes: Array<{ firstIndex: number; lastIndex: number; file: string }> = Array.from({ length: totalSegments }, (_, i) => ({
    firstIndex: i,
    lastIndex: i,
    file: `segment_${String(i).padStart(4, "0")}.mp4`,
  }));
  for (let pass = 0; pass < startPass; pass += 1) {
    const next: Array<{ firstIndex: number; lastIndex: number; file: string }> = [];
    for (let i = 0; i + 1 < nodes.length; i += 2) {
      next.push({
        firstIndex: nodes[i].firstIndex,
        lastIndex: nodes[i + 1].lastIndex,
        file: `pass${pass}_${String(i / 2).padStart(4, "0")}.mp4`,
      });
    }
    if (nodes.length % 2 === 1) next.push(nodes[nodes.length - 1]);
    nodes = next;
  }
  return nodes;
}

/** Restaure l'état depuis le disque : fichiers + durées réelles (ffprobe). */
async function restoreState(params: {
  io: EngineIo;
  plan: RenderPlan;
  startPass: number;
}): Promise<MergeNode[] | null> {
  if (params.startPass <= 0) return null;
  try {
    const mapping = simulateMapping(params.plan.segments.length, params.startPass);
    const restored: MergeNode[] = [];
    for (const node of mapping) {
      const path = join(params.io.tmpDir, node.file);
      await fsp.access(path);
      const probe = await probeMedia(path, params.io.tmpDir);
      restored.push({ file: path, durationSec: probe.durationSec ?? 0, firstIndex: node.firstIndex, lastIndex: node.lastIndex });
    }
    if (restored.some((n) => n.durationSec <= 0)) return null;
    return restored;
  } catch {
    return null; // fichiers absents : reprise depuis les segments initiaux
  }
}

export interface RecursiveAssembleResult {
  file: string;
  passesCompleted: number;
  expectedDurationSec: number;
}

/**
 * Assemblage récursif des transitions. Reprise : `startPass` =
 * job.checkpoints.transitionPass — si les fichiers de la passe précédente
 * existent, l'état est restauré depuis le disque (durées ffprobe réelles)
 * et la fusion continue ; sinon, reprise depuis les segments initiaux.
 */
export async function assembleRecursive(params: {
  plan: RenderPlan;
  io: EngineIo;
  segmentFiles: string[];
  startPass: number;
  onPassDone: (pass: number, files: string[]) => Promise<void>;
}): Promise<RecursiveAssembleResult> {
  const { plan, io } = params;

  let current: MergeNode[];
  let pass: number;
  const restored = await restoreState({ io, plan, startPass: params.startPass });
  if (restored && restored.length > 1) {
    current = restored;
    pass = params.startPass;
    await io.log(`Assemblage repris à la passe ${pass} (${current.length} fichier(s) restaurés).`);
  } else {
    current = params.segmentFiles.map((file, i) => ({
      file,
      durationSec: plan.segments[i].durationSec,
      firstIndex: i,
      lastIndex: i,
    }));
    pass = 0;
  }

  const transitionAfter = new Map<number, { name: string; durationSec: number }>();
  plan.transitions.forEach((t) =>
    transitionAfter.set(t.afterSegmentIndex, { name: t.name, durationSec: Math.max(0.04, t.durationSec) }),
  );

  while (current.length > 1) {
    const next: MergeNode[] = [];
    for (let i = 0; i + 1 < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1];
      const boundary = transitionAfter.get(left.lastIndex);
      const tSec = boundary
        ? Math.min(boundary.durationSec, Math.min(left.durationSec, right.durationSec) / 2)
        : 0.04;
      const mode =
        xfadeTransitionName((boundary?.name as RenderPlan["segments"][number]["transitionIn"]) ?? "cut") ?? "fade";
      const outFile = join(io.tmpDir, `pass${pass}_${String(i / 2).padStart(4, "0")}.mp4`);
      const offset = Math.max(0, left.durationSec - tSec);
      await runFfmpeg({
        args: [
          "-i", left.file,
          "-i", right.file,
          "-filter_complex", `[0:v][1:v]xfade=transition=${mode}:duration=${tSec.toFixed(3)}:offset=${offset.toFixed(3)}[v]`,
          "-map", "[v]",
          "-r", String(plan.fps),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
          "-an",
          outFile,
        ],
        cwd: io.tmpDir,
        outputDurationSec: left.durationSec + right.durationSec - tSec,
        outputPaths: [outFile],
      });
      next.push({
        file: outFile,
        durationSec: Math.round((offset + right.durationSec) * 1000) / 1000,
        firstIndex: left.firstIndex,
        lastIndex: right.lastIndex,
      });
    }
    if (current.length % 2 === 1) next.push(current[current.length - 1]);
    current = next;
    pass += 1;
    await params.onPassDone(pass, current.map((c) => c.file));
    await io.log(`Assemblage : passe ${pass} terminée (${current.length} fichier(s)).`);
  }

  return {
    file: current[0]?.file ?? join(io.tmpDir, "video_noaudio.mp4"),
    passesCompleted: pass,
    expectedDurationSec: Math.round((current[0]?.durationSec ?? plan.estimatedSec) * 1000) / 1000,
  };
}

/** Nettoyage des fichiers intermédiaires de passes (fin de job). */
export async function cleanupPassFiles(tmpDir: string): Promise<void> {
  try {
    const entries = await fsp.readdir(tmpDir);
    await Promise.all(
      entries
        .filter((e) => /^pass\d+_\d+\.mp4$/.test(e) || /^segment_\d+\.mp4$/.test(e) || e === "video_noaudio.mp4")
        .map((e) => fsp.rm(join(tmpDir, e), { force: true })),
    );
  } catch {
    void 0; // tmp déjà purgé
  }
}
