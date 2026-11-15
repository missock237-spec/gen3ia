import "server-only";

/**
 * GEN3IA VIDEO AGENT — Task 119 : moteur de SYNCHRONISATION VOIX-VISUEL.
 *
 * « Vrai CapCut » : les animations d'une scène suivent l'ÉNERGIE RÉELLE de la
 * narration. Le module analyse l'audio (astats FFmpeg, RMS par fenêtres) et
 * produit une TIMELINE D'AMPLITUDE normalisée par scène, puis la traduit en
 * paramètres déterministes :
 *
 *   - POUls de présence (voice_pulse) : micro-oscillation d'échelle caméra
 *     pilotée par la courbe d'amplitude (expression FFmpeg interpolée en
 *     sinusoïdes PAR SEGMENTS — recette déterministe du catalogue, jamais
 *     une chaîne arbitraire) ;
 *   - PUNCH sur pics (punch_zoom) : accélération ponctuelle du zoom caméra
 *     aux instants de pics d'énergie (somme de gaussiennes) ;
 *   - CUTS ALIGNÉS : les transitions entre scènes tombent sur les silences /
 *     fins de phrase quand c'est possible (marge bornée autour de la
 *     frontière — le planner de segments redistribue la durée).
 *
 * HONNÊTETÉ (documentée volontairement) : il s'agit d'une synchronisation
 * ANIMATION-VOIX (présence, pouls, rythme des coupes) et NON d'un lip-sync
 * morphologique complet — les lèvres d'un personnage image par image ne sont
 * pas animées. Les options de scène le reflètent (subject: "person" active
 * les effets audio-réactifs de présence).
 *
 * Tout ce qui est pur (parsage, timelines, expressions, alignement) est
 * testé unitairement ; la seule primitive I/O est analyzeNarrationAmplitude
 * (astats via runFfmpeg — bac à sable identique au reste du pipeline).
 */

import { runFfmpeg } from "@/lib/video/ffmpeg";
import type { ScriptScene } from "@/lib/video/types";

// ────────────────────────────────────────────────────────────────────────────
// Constantes du moteur (bornées, aucun LLM)
// ────────────────────────────────────────────────────────────────────────────

/** Fenêtre d'échantillonnage de l'énergie (s) — granularité de la courbe. */
export const VOICE_SYNC_WINDOW_SEC = 0.2;
/** Plancher dB : tout RMS sous ce niveau est considéré comme silence d'énergie. */
export const VOICE_SYNC_FLOOR_DB = -55;
/** Fenêtre RMS sous ce seuil = silence de parole (pausa entre phrases). */
export const VOICE_SILENCE_DB = -42;
/** Durée minimale d'un silence exploitable pour un alignement de coupe (s). */
export const VOICE_SILENCE_MIN_SEC = 0.12;
/** Ratio du maximum pour déclarer un PIC d'énergie (accélération caméra). */
export const VOICE_PEAK_RATIO = 0.72;
/** Nombre maximal de pics retenus par scène (bornage des expressions). */
export const VOICE_MAX_PEAKS = 4;
/** Nombre maximal de points de la courbe d'amplitude embarquée (bornage). */
export const VOICE_MAX_AMPLITUDE_POINTS = 24;
/** Marge maximale de déplacement d'une frontière de scène (s). */
export const VOICE_CUT_MARGIN_SEC = 0.35;
/** Décalage minimal perceptible pour déplacer une coupe (s). */
export const VOICE_CUT_MIN_SHIFT_SEC = 0.06;

// ────────────────────────────────────────────────────────────────────────────
// Types (sérialisables — embarqués dans le plan de rendu)
// ────────────────────────────────────────────────────────────────────────────

/** Échantillon RMS brut (une trame audio astats). */
export interface AmplitudeSample {
  timeSec: number;
  rmsDb: number;
}

/** Fenêtre d'énergie agrégée, normalisée 0..1 sur la scène. */
export interface AmplitudeWindow {
  startSec: number;
  endSec: number;
  /** RMS moyen (dB) de la fenêtre (planché à VOICE_SYNC_FLOOR_DB). */
  rmsDb: number;
  /** 0..1 — énergie relative au maximum de la narration. */
  normalized: number;
}

/** Intervalle de silence de parole détecté. */
export interface SilenceRange {
  startSec: number;
  endSec: number;
}

/** Timeline d'amplitude d'une narration de scène. */
export interface VoiceTimeline {
  windowSec: number;
  durationSec: number;
  windows: AmplitudeWindow[];
  silences: SilenceRange[];
  /** Instants (s) des pics d'énergie vocale (≤ VOICE_MAX_PEAKS). */
  peakTimesSec: number[];
}

/** Courbe compacte embarquée dans le plan de rendu (sérialisable Firestore). */
export interface VoiceSyncPlan {
  /** Points d'amplitude normalisée échantillonnés sur la scène (0..1). */
  amplitude: Array<{ tSec: number; value: number }>;
  /** Instants des pics d'énergie (s, début de scène = 0). */
  peakTimesSec: number[];
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Analyse audio — parsage astats/ametadata (pur)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse la sortie ametadata d'astats (paires frame/pts_time + RMS_level).
 * PUR et tolérant : lignes inconnues ignorées, `-inf` → plancher, valeurs
 * non finies écartées. Sortie ordonnée par temps.
 */
export function parseAstatsRmsStdout(stdout: string): AmplitudeSample[] {
  const samples: AmplitudeSample[] = [];
  let pendingTime: number | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const timeMatch = rawLine.match(/pts_time:(-?[\d.]+)/);
    if (timeMatch) {
      const t = Number(timeMatch[1]);
      pendingTime = Number.isFinite(t) && t >= 0 ? t : null;
      continue;
    }
    const rmsMatch = rawLine.match(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf)/);
    if (rmsMatch && pendingTime !== null) {
      const raw = rmsMatch[1];
      const db = raw === "-inf" ? VOICE_SYNC_FLOOR_DB : Number(raw);
      if (Number.isFinite(db)) {
        samples.push({ timeSec: Math.round(pendingTime * 1000) / 1000, rmsDb: Math.max(db, VOICE_SYNC_FLOOR_DB) });
      }
      pendingTime = null;
    }
  }
  return samples.sort((a, b) => a.timeSec - b.timeSec);
}

/**
 * Regroupe les échantillons RMS en fenêtres fixes (PUR). Les fenêtres sans
 * échantillon sont posées au plancher (silence) pour rester régulières.
 */
export function bucketRmsWindows(
  samples: ReadonlyArray<AmplitudeSample>,
  durationSec: number,
  windowSec = VOICE_SYNC_WINDOW_SEC,
): Array<{ startSec: number; endSec: number; rmsDb: number }> {
  const safeWindow = Math.max(0.05, windowSec);
  const safeDuration = Math.max(safeWindow, Number.isFinite(durationSec) && durationSec > 0 ? durationSec : safeWindow);
  const count = Math.min(600, Math.max(1, Math.ceil(safeDuration / safeWindow)));
  const sums = new Array<number>(count).fill(0);
  const counts = new Array<number>(count).fill(0);
  for (const sample of samples) {
    if (sample.timeSec < 0 || sample.timeSec >= safeDuration) continue;
    const index = Math.min(count - 1, Math.floor(sample.timeSec / safeWindow));
    sums[index] += sample.rmsDb;
    counts[index] += 1;
  }
  const windows: Array<{ startSec: number; endSec: number; rmsDb: number }> = [];
  for (let i = 0; i < count; i += 1) {
    windows.push({
      startSec: Math.round(i * safeWindow * 1000) / 1000,
      endSec: Math.round(Math.min((i + 1) * safeWindow, safeDuration) * 1000) / 1000,
      rmsDb: counts[i] > 0 ? sums[i] / counts[i] : VOICE_SYNC_FLOOR_DB,
    });
  }
  return windows;
}

// ────────────────────────────────────────────────────────────────────────────
// 2. Timeline d'amplitude — normalisation, silences, pics (pur)
// ────────────────────────────────────────────────────────────────────────────

export interface VoiceTimelineOptions {
  floorDb?: number;
  silenceDb?: number;
  minSilenceSec?: number;
  peakRatio?: number;
  maxPeaks?: number;
}

/**
 * Construit la timeline d'amplitude : normalisation 0..1 (plancher → 0,
 * max réel → 1), silences (fenêtres sous le seuil fusionnées), pics (maxima
 * locaux ≥ ratio du maximum, dedupliqués, triés, bornés).
 */
export function buildVoiceTimeline(
  windows: ReadonlyArray<{ startSec: number; endSec: number; rmsDb: number }>,
  options: VoiceTimelineOptions = {},
): VoiceTimeline {
  const floorDb = options.floorDb ?? VOICE_SYNC_FLOOR_DB;
  const silenceDb = options.silenceDb ?? VOICE_SILENCE_DB;
  const minSilenceSec = options.minSilenceSec ?? VOICE_SILENCE_MIN_SEC;
  const peakRatio = options.peakRatio ?? VOICE_PEAK_RATIO;
  const maxPeaks = options.maxPeaks ?? VOICE_MAX_PEAKS;

  const maxDb = windows.reduce((max, w) => Math.max(max, w.rmsDb), floorDb);
  const span = Math.max(1e-6, maxDb - floorDb);
  const normalized = windows.map((w) => ({
    ...w,
    normalized: Math.min(1, Math.max(0, (w.rmsDb - floorDb) / span)),
  }));

  // Silences : fenêtres sous le seuil, fusionnées en intervalles continus.
  const silences: SilenceRange[] = [];
  let currentStart: number | null = null;
  let currentEnd = 0;
  for (const w of normalized) {
    const silent = w.rmsDb < silenceDb;
    if (silent) {
      if (currentStart === null) currentStart = w.startSec;
      currentEnd = w.endSec;
    } else if (currentStart !== null) {
      silences.push({ startSec: currentStart, endSec: currentEnd });
      currentStart = null;
    }
  }
  if (currentStart !== null) silences.push({ startSec: currentStart, endSec: currentEnd });

  // Pics : maxima LOCAUX significatifs (montée puis descente), triés par
  // énergie décroissante puis chronologique, bornés à maxPeaks.
  const peakThreshold = peakRatio;
  const candidates: Array<{ centerSec: number; value: number }> = [];
  normalized.forEach((w, i) => {
    if (w.normalized < peakThreshold) return;
    const prev = normalized[i - 1];
    const next = normalized[i + 1];
    const isLocalMax = (!prev || w.normalized >= prev.normalized) && (!next || w.normalized >= next.normalized);
    if (!isLocalMax) return;
    candidates.push({ centerSec: Math.round(((w.startSec + w.endSec) / 2) * 1000) / 1000, value: w.normalized });
  });
  const peakTimesSec = candidates
    .sort((a, b) => (b.value - a.value) || (a.centerSec - b.centerSec))
    .slice(0, maxPeaks)
    .map((c) => c.centerSec)
    .sort((a, b) => a - b);

  const durationSec = normalized.length > 0 ? normalized[normalized.length - 1].endSec : 0;
  return {
    windowSec: normalized.length > 0 ? Math.round((normalized[0].endSec - normalized[0].startSec) * 1000) / 1000 : VOICE_SYNC_WINDOW_SEC,
    durationSec: Math.round(durationSec * 1000) / 1000,
    windows: normalized,
    silences: silences.filter((s) => s.endSec - s.startSec >= minSilenceSec),
    peakTimesSec,
  };
}

/** Amplitude normalisée interpolée à l'instant t (pur, hors bornes → 0). */
export function amplitudeAt(timeline: VoiceTimeline, tSec: number): number {
  for (const w of timeline.windows) {
    if (tSec >= w.startSec && tSec < w.endSec) return w.normalized;
  }
  return tSec >= timeline.durationSec && timeline.windows.length > 0 ? timeline.windows[timeline.windows.length - 1].normalized : 0;
}

// ────────────────────────────────────────────────────────────────────────────
// 3. Expressions FFmpeg déterministes (sinusoïdes par segments)
// ────────────────────────────────────────────────────────────────────────────

/** Point d'expression : position dans l'unité de la variable FFmpeg. */
export interface ExprPoint {
  pos: number;
  value: number;
}

/**
 * Interpolation SINUSOÏDALE PAR SEGMENTS d'une courbe échantillonnée :
 * chaque segment [p_k, p_{k+1}] est v_k + (v_{k+1}−v_k)·sin(π/2·(x−p_k)/Δ)
 * — dérivée nulle aux points d'échantillonnage (courbe lisse, respiration
 * naturelle), paliers constants aux extrémités. RECETTE DÉTERMINISTE : les
 * mêmes points produisent EXACTEMENT la même expression.
 *
 * `varName` : variable FFmpeg de la trame courante ("on" pour zoompan,
 * "n" pour rotate, "t" pour crop/enable).
 */
export function buildSinusoidalExpr(points: ReadonlyArray<ExprPoint>, varName: "on" | "n" | "t", decimals = 4): string {
  const finite = points.filter((p) => Number.isFinite(p.pos) && Number.isFinite(p.value));
  if (finite.length === 0) return "0";
  if (finite.length === 1) return finite[0].value.toFixed(decimals);
  if (finite.every((p) => Math.abs(p.value - finite[0].value) < 1e-9)) {
    return finite[0].value.toFixed(decimals);
  }
  const segments: string[] = [];
  for (let i = 0; i < finite.length - 1; i += 1) {
    const a = finite[i];
    const b = finite[i + 1];
    const span = Math.max(1e-6, b.pos - a.pos);
    const base = a.value.toFixed(decimals);
    const delta = (b.value - a.value).toFixed(decimals);
    // Palier constant à gauche du premier point / droite du dernier ; le
    // ratio est la DISTANCE à a dans [0, span] (segment initial inclus — le
    // clip seul suffit quand a.pos = 0, la division par span serait b²).
    const ratio = a.pos === 0
      ? `clip(${varName},0,${b.pos.toFixed(decimals)})`
      : `clip(${varName},${a.pos.toFixed(decimals)},${b.pos.toFixed(decimals)})-(${a.pos.toFixed(decimals)})`;
    const arg = `(PI/2*(${ratio})/${span.toFixed(decimals)})`;
    const expr = delta === "0.0000" || Number(delta) === 0
      ? base
      : `${base}+(${delta})*sin(${arg})`;
    segments.push(expr);
  }
  let expr = segments[segments.length - 1];
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    expr = `if(lte(${varName},${finite[i + 1].pos.toFixed(decimals)}),${segments[i]},${expr})`;
  }
  return expr;
}

/**
 * Rééchantillonne la timeline d'amplitude aux positions `tSec` régulières
 * (borné à maxPoints) — les points alimentent buildSinusoidalExpr.
 */
export function sampleAmplitudePoints(
  timeline: VoiceTimeline,
  durationSec: number,
  sampleStepSec = 0.5,
  maxPoints = VOICE_MAX_AMPLITUDE_POINTS,
): Array<{ tSec: number; value: number }> {
  const safeDuration = Math.max(0.1, Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0.1);
  const step = Math.max(0.1, sampleStepSec);
  const target = Math.max(2, Math.min(maxPoints, Math.ceil(safeDuration / step) + 1));
  const effectiveStep = safeDuration / (target - 1);
  const points: Array<{ tSec: number; value: number }> = [];
  for (let i = 0; i < target; i += 1) {
    const t = Math.round(i * effectiveStep * 1000) / 1000;
    points.push({ tSec: t, value: Math.round(amplitudeAt(timeline, t) * 1000) / 1000 });
  }
  return points;
}

/**
 * Expression du POUls caméra (zoompan, variable `on`) : amplitude vocale
 * échantillonnée × amplitude d'oscillation selon l'intensité de l'effet.
 * Retourne NULL si la scène est trop courte pour respirer (< 0.8 s).
 */
export function buildVoicePulseZoomExpr(
  plan: VoiceSyncPlan,
  params: { fps: number; durationSec: number; amplitude: number },
): string | null {
  if (plan.amplitude.length < 2) return null;
  if (params.durationSec < 0.8) return null;
  const fps = Math.max(1, params.fps);
  const points: ExprPoint[] = plan.amplitude.map((p) => ({
    pos: Math.round(p.tSec * fps),
    value: Math.round(Math.max(0, params.amplitude) * p.value * 10000) / 10000,
  }));
  return buildSinusoidalExpr(points, "on");
}

/**
 * Expression du PUNCH caméra (zoompan, variable `on`) : somme de gaussiennes
 * centrées sur les pics d'énergie vocale. Vide → null (aucun punch).
 */
export function buildPunchZoomExpr(
  peakTimesSec: ReadonlyArray<number>,
  params: { fps: number; amplitude: number; widthSec?: number; maxPeaks?: number },
): string | null {
  const peaks = peakTimesSec
    .filter((t) => Number.isFinite(t) && t >= 0)
    .slice(0, params.maxPeaks ?? VOICE_MAX_PEAKS);
  if (peaks.length === 0) return null;
  const fps = Math.max(1, params.fps);
  // Amplitude bornée ≥ 0 : un punch ne dé-zoome JAMAIS la caméra.
  const amplitude = Math.max(0, params.amplitude);
  const widthSec = params.widthSec ?? 0.22;
  // La variable `on` est en FRAMES : la largeur de gaussienne aussi (une
  // largeur en secondes donnerait un spike d'UNE frame au lieu d'un punch
  // perceptible de ~0.22 s).
  const sigma2 = (Math.max(1, widthSec * fps) ** 2).toFixed(4);
  const terms = peaks.map((t) => {
    const center = (t * fps).toFixed(1);
    return `(${amplitude.toFixed(4)})*exp(-(pow(on-${center},2))/${sigma2})`;
  });
  return terms.reduce((sum, term) => `(${sum})+(${term})`).replace(/^\((.*)\)$/, "$1");
}

// ────────────────────────────────────────────────────────────────────────────
// 4. Coupes alignées sur l'énergie (pur)
// ────────────────────────────────────────────────────────────────────────────

export interface AlignedSceneDuration {
  id: string;
  durationSec: number;
  startSec: number;
}

export interface CutAlignmentOptions {
  marginSec?: number;
  minShiftSec?: number;
  minSceneSec?: number;
  /** Seuil dB d'une fenêtre « parlée » (défaut VOICE_SILENCE_DB). */
  silenceDb?: number;
}

/**
 * Aligne les frontières entre scènes sur les silences / fins de phrase de la
 * narration : pour chaque frontière interne, les candidats sont les milieux
 * de silences et la fin de la dernière fenêtre NON silencieuse de la scène A
 * (fin de phrase), plus le début de la parole de la scène B. Le candidat le
 * plus proche de la frontière gagne ; le décalage est borné par la marge et
 * redistribué entre les deux scènes adjacentes (durée TOTALE inchangée).
 *
 * PUR : aucune mutation, retour d'un nouveau tableau avec startSec recalculés.
 */
export function alignSceneBoundariesToSilences(
  scenes: ReadonlyArray<{ id: string; durationSec: number }>,
  voiceSyncByScene: ReadonlyMap<string, Pick<VoiceTimeline, "silences" | "windows">>,
  options: CutAlignmentOptions = {},
): AlignedSceneDuration[] {
  const margin = options.marginSec ?? VOICE_CUT_MARGIN_SEC;
  const minShift = options.minShiftSec ?? VOICE_CUT_MIN_SHIFT_SEC;
  const minScene = options.minSceneSec ?? 1;
  const silenceDb = options.silenceDb ?? VOICE_SILENCE_DB;
  // Fenêtre « parlée » : MÊME seuil que la détection des silences (une
  // fenêtre sous le seuil n'est PAS une fin de phrase, même si son énergie
  // résiduelle normalisée dépasse un fixed 0.05).
  const isSpoken = (w: { rmsDb: number }) => w.rmsDb >= silenceDb;

  const durations = scenes.map((s) => Math.max(minScene, Number.isFinite(s.durationSec) ? s.durationSec : minScene));
  const boundaries: number[] = [];
  let cursor = 0;
  for (const d of durations) {
    cursor += d;
    boundaries.push(Math.round(cursor * 1000) / 1000);
  }

  for (let k = 0; k < scenes.length - 1; k += 1) {
    const boundary = boundaries[k];
    const syncA = voiceSyncByScene.get(scenes[k].id);
    if (!syncA) continue;
    // Les fenêtres de la timeline A sont RELATIVES au début de A (la
    // narration démarre avec sa scène) : conversion en temps ABSOLU.
    const startA = boundary - durations[k];
    const candidates: number[] = [];
    for (const silence of syncA.silences) {
      candidates.push(startA + (silence.startSec + silence.endSec) / 2);
    }
    // Fin de phrase = fin de la dernière fenêtre NON silencieuse de A.
    const spoken = syncA.windows.filter(isSpoken);
    if (spoken.length > 0) {
      const lastSpeechEnd = startA + spoken[spoken.length - 1].endSec;
      // Fin de narration proche de la frontière (≤ 1 s après) : candidat.
      if (lastSpeechEnd >= boundary - margin && lastSpeechEnd <= boundary + 1) {
        candidates.push(lastSpeechEnd);
      }
    }
    const syncB = voiceSyncByScene.get(scenes[k + 1].id);
    if (syncB) {
      const firstSpoken = syncB.windows.find(isSpoken);
      if (firstSpoken && firstSpoken.startSec <= margin) {
        candidates.push(boundary + firstSpoken.startSec);
      }
    }
    const inRange = candidates.filter((c) => c >= boundary - margin && c <= boundary + margin);
    if (inRange.length === 0) continue;
    const best = inRange.reduce((closest, c) => (Math.abs(c - boundary) < Math.abs(closest - boundary) ? c : closest));
    const delta = Math.max(-margin, Math.min(margin, best - boundary));
    if (Math.abs(delta) < minShift) continue;
    // Redistribution bornée : A garde au moins minScene, B aussi.
    const roomA = durations[k] - minScene;
    const roomB = durations[k + 1] - minScene;
    const shift = Math.max(-roomA, Math.min(roomB, delta));
    if (Math.abs(shift) < minShift) continue;
    durations[k] = Math.round((durations[k] + shift) * 1000) / 1000;
    durations[k + 1] = Math.round((durations[k + 1] - shift) * 1000) / 1000;
    // Recalcule les frontières suivantes (décalage propagé).
    let recompute = 0;
    const nextBoundaries: number[] = [];
    for (let i = 0; i < durations.length; i += 1) {
      recompute += durations[i];
      nextBoundaries.push(Math.round(recompute * 1000) / 1000);
    }
    boundaries.splice(0, boundaries.length, ...nextBoundaries);
  }

  let start = 0;
  return scenes.map((scene, i) => {
    const entry = { id: scene.id, durationSec: durations[i], startSec: Math.round(start * 1000) / 1000 };
    start += durations[i];
    return entry;
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 5. Détection de PERSONNE (sujet parlant) — pur
// ────────────────────────────────────────────────────────────────────────────

/** Motifs visuels évocateurs d'une personne cadrée (prompt EN du Script Engine). */
const PERSON_PROMPT_RE = /\b(person|people|man|woman|men|women|girl|boy|child|portrait|face|speaker|host|presenter|narrator|character|chef|doctor|scientist|student|woman's|man's)\b/i;

/**
 * true si la scène montre une PERSONNE (sujet parlant) — champ explicite
 * `subject: "person"` du scénario, sinon heuristique sur le prompt visuel.
 * Les effets audio-réactifs de présence (voice_pulse) ne s'appliquent QU'à
 * ces scènes (honnêteté : présence/pouls, pas un lip-sync morphologique).
 */
export function sceneHasSpeaker(scene: Pick<ScriptScene, "subject" | "visualPrompt">): boolean {
  if (scene.subject === "person") return true;
  if (scene.subject) return false; // sujet explicite non humain
  return PERSON_PROMPT_RE.test(scene.visualPrompt ?? "");
}

// ────────────────────────────────────────────────────────────────────────────
// 6. Analyse réelle d'une narration (I/O — bac à sable runFfmpeg)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Analyse l'énergie d'un fichier de narration (tmp local) : astats par trame
 * → fenêtres → timeline (silences + pics). Retourne null si l'analyse
 * échoue ou si l'audio est absent/court (dégradation honnête : aucun effet
 * audio-réactif, le rendu continue).
 */
export async function analyzeNarrationAmplitude(params: {
  audioFile: string;
  cwd: string;
  durationSec?: number;
  windowSec?: number;
}): Promise<VoiceTimeline | null> {
  const windowSec = params.windowSec ?? VOICE_SYNC_WINDOW_SEC;
  try {
    const result = await runFfmpeg({
      args: [
        "-i", params.audioFile,
        "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
        "-vn",
        "-f", "null", "-",
      ],
      cwd: params.cwd,
      // Le flux ametadata part sur stderr : le stdout reste vide, le parse
      // lit le stderr agrégé (contrat identique à volumedetect côté QC).
      outputDurationSec: params.durationSec && params.durationSec > 0 ? params.durationSec : 30,
    });
    const samples = parseAstatsRmsStdout(`${result.stdout}\n${result.stderr}`);
    if (samples.length === 0) return null;
    const duration = params.durationSec && params.durationSec > 0
      ? params.durationSec
      : (samples[samples.length - 1].timeSec + windowSec);
    return buildVoiceTimeline(bucketRmsWindows(samples, duration, windowSec));
  } catch {
    return null; // audio absent/illisible : jamais bloquant pour le rendu
  }
}

/**
 * Construit le plan de synchro compact d'une scène (points d'amplitude +
 * pics) depuis la timeline — borné, sérialisable dans le plan de rendu.
 */
export function buildVoiceSyncPlan(timeline: VoiceTimeline, sceneDurationSec: number): VoiceSyncPlan {
  return {
    amplitude: sampleAmplitudePoints(timeline, sceneDurationSec),
    peakTimesSec: timeline.peakTimesSec.map((t) => Math.round(t * 1000) / 1000),
  };
}
