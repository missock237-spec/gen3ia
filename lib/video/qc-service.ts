import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 17 : Quality Control Agent (spec §20).
 *
 * Après le rendu, l'agent QC analyse le master RÉELLEMENT (ffprobe +
 * filtres d'analyse FFmpeg) :
 *   audio clipping ? silence excessif ? écrans noirs ? scène trop longue ?
 *   sous-titres synchronisés ? volume cohérent ? durée correcte ?
 *   flux audio présent ? résolution/fps conformes ?
 *
 * Chaque problème porte un correctif automatique proposé ; le worker
 * applique les correctifs (≤ MAX_AUTO_FIX_ROUNDS) puis relance un rendu
 * ciblé (segment/audio/sous-titres) — boucle PROBLÈME → CORRECTION →
 * NOUVEAU RENDU de la spécification.
 */

import type { QcIssue, QcReport, RenderPlan, RenderSegment, VideoProject } from "@/lib/video/types";
import { runFfmpeg, probeMedia } from "@/lib/video/ffmpeg";
import { loadJobDoc } from "@/lib/video/queue-resume";
import { PROJECTS_COLLECTION } from "@/lib/video/project-service";

const MAX_SCENE_SEC = 45;
const MAX_SILENCE_RATIO = 0.35; // >35 % de silence total = problème
const CLIPPING_DB = -0.5; // max_volume ≥ -0.5 dB = clipping probable
const DURATION_TOLERANCE = 0.05; // ±5 %

// ────────────────────────────────────────────────────────────────────────────
// Task 106-c — QC missing_asset : scènes attendues sans segment rendu
// ────────────────────────────────────────────────────────────────────────────

/** Scène attendue (dérivée du scénario du projet). */
export interface ExpectedScene {
  id: string;
  /** Index 0-based dans le scénario (numérotation lisible = index + 1). */
  index?: number;
}

/**
 * Numéro lisible d'une scène (1-based) : champ `index` du scénario si
 * présent, sinon sa position dans la liste attendue.
 */
export function expectedSceneNumber(scene: ExpectedScene, fallbackPosition: number): number {
  if (typeof scene.index === "number" && Number.isFinite(scene.index) && scene.index >= 0) {
    return scene.index + 1;
  }
  return fallbackPosition + 1;
}

/**
 * Détecte les scènes attendues (scénario) ABSENTES des segments réellement
 * rendus — buildRenderPlan ignore silencieusement les scènes sans image :
 * cette passe rend le manque VISIBLE dans le rapport QC (Task 106-c).
 *
 * PURE et testée. Une SEULE issue `missing_asset` (severity warning) liste
 * toutes les scènes manquantes : severity warning → passed inchangé (pas de
 * boucle auto-fix) et suggestedFix SANS segmentIndex (aucun segment n'existe
 * pour une scène absente — decideAutoFix ne re-rendra jamais un segment
 * fantôme) : le payload porte les sceneIds pour l'agent/l'UI.
 */
export function detectMissingAssetIssues(
  expectedScenes: ReadonlyArray<ExpectedScene>,
  segments: ReadonlyArray<Pick<RenderSegment, "sceneId" | "index">>,
): QcIssue[] {
  if (expectedScenes.length === 0) return [];
  const renderedSceneIds = new Set(segments.map((s) => s.sceneId));
  const missing = expectedScenes
    .map((scene, position) => ({ scene, number: expectedSceneNumber(scene, position) }))
    .filter(({ scene }) => !renderedSceneIds.has(scene.id));
  if (missing.length === 0) return [];
  const numbers = missing.map(({ number }) => number);
  const detail =
    missing.length === 1
      ? `Scène ${numbers[0]} sans visuel rendu : absente du montage final (image non générée ou scène ignorée).`
      : `Scènes ${numbers.join(", ")} sans visuel rendu : absentes du montage final (images non générées ou scènes ignorées).`;
  return [
    {
      kind: "missing_asset",
      severity: "warning",
      detail,
      suggestedFix: { type: "regenerate_segment", payload: { sceneIds: missing.map(({ scene }) => scene.id) } },
    },
  ];
}

/**
 * Charge les scènes attendues depuis le scénario du projet (best-effort via
 * la couche résiliente —Firestore d'abord, miroir chaud sous quota). Retourne
 * undefined si le projet/scénario est indisponible : la passe missing_asset
 * est alors silencieusement ignorée (jamais de fausse alerte).
 */
async function loadExpectedScenes(projectId: string): Promise<ExpectedScene[] | undefined> {
  try {
    const project = await loadJobDoc<VideoProject>(PROJECTS_COLLECTION, projectId);
    const scenes = project?.script?.scenes;
    if (!scenes || scenes.length === 0) return undefined;
    return scenes.map((scene) => ({ id: scene.id, index: scene.index }));
  } catch {
    return undefined;
  }
}

/** Analyse complète du master rendu (fichier local tmp). */
export async function analyzeRenderedMaster(params: {
  masterFile: string;
  tmpDir: string;
  plan: RenderPlan;
  expectedDurationSec: number;
  subtitlesEnabled: boolean;
  subtitleLastCueEndSec?: number;
  /**
   * Task 106-c — scènes attendues (scénario) pour la passe missing_asset.
   * Absente → chargées depuis le projet (plan.projectId) en best-effort.
   */
  expectedScenes?: ReadonlyArray<ExpectedScene>;
}): Promise<QcReport> {
  const issues: QcIssue[] = [];

  const probe = await probeMedia(params.masterFile, params.tmpDir).catch(() => undefined);

  // 1. Durée attendue vs réelle.
  if (probe?.durationSec) {
    const drift = Math.abs(probe.durationSec - params.expectedDurationSec) / Math.max(1, params.expectedDurationSec);
    if (drift > DURATION_TOLERANCE) {
      issues.push({
        kind: "duration_mismatch",
        severity: drift > 0.15 ? "critical" : "warning",
        detail: `Durée rendue ${probe.durationSec.toFixed(1)} s ≠ attendue ${params.expectedDurationSec.toFixed(1)} s (écart ${(drift * 100).toFixed(1)} %).`,
        suggestedFix: { type: "retime_segment" },
      });
    }
  } else {
    issues.push({ kind: "duration_mismatch", severity: "critical", detail: "Durée du master illisible (ffprobe sans résultat)." });
  }

  // 2. Flux audio présent (si narration ou musique attendue).
  const audioExpected = params.plan.audioMix.narration.length > 0 || params.plan.audioMix.music.length > 0 || params.plan.audioMix.sfx.length > 0;
  if (audioExpected && probe && probe.hasAudio === false) {
    issues.push({
      kind: "missing_audio_stream",
      severity: "critical",
      detail: "Aucun flux audio dans le master alors que narration/musique étaient prévues.",
      suggestedFix: { type: "rebuild_audio" },
    });
  }

  // 3. Volume : clipping + cohérence (volumedetect).
  const volume = await measureVolume(params.masterFile, params.tmpDir);
  if (volume) {
    if (volume.maxVolumeDb >= CLIPPING_DB) {
      issues.push({
        kind: "audio_clipping",
        severity: "warning",
        detail: `Crête audio à ${volume.maxVolumeDb.toFixed(1)} dB — clipping probable.`,
        suggestedFix: { type: "rebuild_audio" },
      });
    }
    if (volume.meanVolumeDb < -40 && audioExpected) {
      issues.push({
        kind: "volume_inconsistent",
        severity: "warning",
        detail: `Volume moyen très bas (${volume.meanVolumeDb.toFixed(1)} dB).`,
        suggestedFix: { type: "rebuild_audio" },
      });
    }
  }

  // 4. Silence excessif.
  const silence = await measureSilence(params.masterFile, params.tmpDir);
  if (silence && probe?.durationSec) {
    const ratio = silence.totalSec / probe.durationSec;
    if (ratio > MAX_SILENCE_RATIO) {
      issues.push({
        kind: "excess_silence",
        severity: "warning",
        detail: `${(ratio * 100).toFixed(0)} % de silence total (seuil ${MAX_SILENCE_RATIO * 100} %).`,
        suggestedFix: { type: "retime_segment" },
      });
    }
  }

  // 5. Écrans noirs.
  const black = await measureBlack(params.masterFile, params.tmpDir);
  if (black && probe?.durationSec) {
    const ratio = black.totalSec / probe.durationSec;
    if (ratio > 0.12) {
      issues.push({
        kind: "black_frames",
        severity: "critical",
        detail: `${(ratio * 100).toFixed(0)} % d'écrans noirs détectés.`,
        suggestedFix: { type: "regenerate_segment" },
      });
    }
  }

  // 6. Scènes anormalement longues.
  for (const segment of params.plan.segments) {
    if (segment.durationSec > MAX_SCENE_SEC) {
      issues.push({
        kind: "scene_too_long",
        severity: "info",
        detail: `Scène ${segment.sceneId} : ${Math.round(segment.durationSec)} s (> ${MAX_SCENE_SEC} s) — rythme à revoir.`,
        segmentIndex: segment.index,
      });
    }
  }

  // 7. Sous-titres désynchronisés (dernière cue au-delà de la durée).
  if (params.subtitlesEnabled && params.subtitleLastCueEndSec !== undefined && probe?.durationSec) {
    if (params.subtitleLastCueEndSec > probe.durationSec + 0.5) {
      issues.push({
        kind: "subtitles_desync",
        severity: "warning",
        detail: `Sous-titres jusqu'à ${params.subtitleLastCueEndSec.toFixed(1)} s > durée vidéo ${probe.durationSec.toFixed(1)} s.`,
        suggestedFix: { type: "reburn_subtitles" },
      });
    }
  }

  // 8. Résolution / fps conformes au plan.
  if (probe?.width && probe?.height) {
    const dimsOk = probe.width >= 640 && probe.height >= 360;
    if (!dimsOk) {
      issues.push({ kind: "bad_transition", severity: "warning", detail: `Résolution inhabituelle ${probe.width}×${probe.height}.` });
    }
  }

  // 9. Task 106-c — missing_asset : scènes du scénario absentes du montage
  // (buildRenderPlan ignore les scènes sans image). Scènes explicites si
  // fournies, sinon relecture best-effort du projet (plan.projectId) — un
  // incident de lecture n'est jamais une fausse alerte QC.
  const expectedScenes = params.expectedScenes ?? (await loadExpectedScenes(params.plan.projectId));
  if (expectedScenes && expectedScenes.length > 0) {
    issues.push(...detectMissingAssetIssues(expectedScenes, params.plan.segments));
  }

  const critical = issues.filter((i) => i.severity === "critical");
  return {
    passed: critical.length === 0,
    checkedAt: new Date().toISOString(),
    issues,
    metrics: {
      durationSec: probe?.durationSec,
      maxVolumeDb: volume?.maxVolumeDb,
      meanVolumeDb: volume?.meanVolumeDb,
      silenceTotalSec: silence?.totalSec,
      blackTotalSec: black?.totalSec,
      hasAudioStream: probe?.hasAudio,
      width: probe?.width,
      height: probe?.height,
      fps: probe?.fps,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Mesures FFmpeg réelles (parsage des journaux d'analyse)
// ────────────────────────────────────────────────────────────────────────────

async function measureVolume(file: string, cwd: string): Promise<{ maxVolumeDb: number; meanVolumeDb: number } | null> {
  try {
    const result = await runFfmpeg({
      args: ["-i", file, "-af", "volumedetect", "-vn", "-f", "null", "-"],
      cwd,
      outputDurationSec: 60,
    });
    const max = result.stderr.match(/max_volume:\s*(-?[\d.]+) dB/);
    const mean = result.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
    if (!max) return null;
    return { maxVolumeDb: Number(max[1]), meanVolumeDb: mean ? Number(mean[1]) : -70 };
  } catch {
    return null;
  }
}

async function measureSilence(file: string, cwd: string): Promise<{ totalSec: number } | null> {
  try {
    const result = await runFfmpeg({
      args: ["-i", file, "-af", "silencedetect=noise=-45dB:d=1.5", "-vn", "-f", "null", "-"],
      cwd,
      outputDurationSec: 60,
    });
    const starts = [...result.stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
    const ends = [...result.stderr.matchAll(/silence_end:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
    let total = 0;
    starts.forEach((start, i) => {
      const end = ends[i];
      if (end !== undefined && end > start) total += end - start;
    });
    return { totalSec: Math.round(total * 100) / 100 };
  } catch {
    return null;
  }
}

async function measureBlack(file: string, cwd: string): Promise<{ totalSec: number } | null> {
  try {
    const result = await runFfmpeg({
      args: ["-i", file, "-vf", "blackdetect=d=0.5:pix_th=0.10", "-an", "-f", "null", "-"],
      cwd,
      outputDurationSec: 60,
    });
    let total = 0;
    for (const match of result.stderr.matchAll(/black_start:\s*([\d.]+)\s*black_end:\s*([\d.]+)/g)) {
      total += Number(match[2]) - Number(match[1]);
    }
    return { totalSec: Math.round(total * 100) / 100 };
  } catch {
    return null;
  }
}

/**
 * Décide de la suite après QC : correctifs applicables (segments à
 * re-rendre, audio à reconstruire, sous-titres à re-brûler) ou validation.
 */
export function decideAutoFix(report: QcReport, plan: RenderPlan): {
  action: "accept" | "fix";
  reRenderSegments: number[];
  rebuildAudio: boolean;
  reburnSubtitles: boolean;
} {
  if (report.passed) return { action: "accept", reRenderSegments: [], rebuildAudio: false, reburnSubtitles: false };
  const reRenderSegments: number[] = [];
  let rebuildAudio = false;
  let reburnSubtitles = false;
  for (const issue of report.issues) {
    if (!issue.suggestedFix || issue.severity === "info") continue;
    switch (issue.suggestedFix.type) {
      case "retime_segment":
        if (issue.segmentIndex !== undefined) reRenderSegments.push(issue.segmentIndex);
        break;
      case "regenerate_segment":
        if (issue.segmentIndex !== undefined) reRenderSegments.push(issue.segmentIndex);
        break;
      case "rebuild_audio":
        rebuildAudio = true;
        break;
      case "reburn_subtitles":
        reburnSubtitles = true;
        break;
      case "replace_transition":
        break;
    }
  }
  // Les corrections ciblées ne s'appliquent que si l'échec est boundé.
  const onlyTransitionsLeft = report.issues.every((i) => i.severity !== "critical" || i.suggestedFix);
  if (!onlyTransitionsLeft && reRenderSegments.length === 0 && !rebuildAudio && !reburnSubtitles) {
    return { action: "accept", reRenderSegments: [], rebuildAudio: false, reburnSubtitles: false };
  }
  void plan;
  return { action: reRenderSegments.length > 0 || rebuildAudio || reburnSubtitles ? "fix" : "accept", reRenderSegments: [...new Set(reRenderSegments)], rebuildAudio, reburnSubtitles };
}
