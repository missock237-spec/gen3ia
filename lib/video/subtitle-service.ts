import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 16 : Subtitle Engine (spec §16).
 *
 * Sous-titres automatiques : découpage intelligent de la narration en
 * cues courtes (max 2 lignes, 42 car/ligne), synchronisation
 * proportionnelle au nombre de caractères dans la fenêtre de la scène,
 * mots importants mis en avant (style Shorts/TikTok), styles multiples,
 * position. Génère de VRAIS fichiers ASS (stylés, brûlés au rendu) et
 * SRT (export/plateformes).
 */

import type { ScriptScene, SubtitleCue, SubtitleStyleName, SubtitleTrackFile } from "@/lib/video/types";

const MAX_LINE_CHARS = 42;
const MAX_LINES = 2;
const MIN_CUE_SEC = 0.9;
const MAX_CUE_SEC = 5.5;

/**
 * Découpe la narration d'une scène en cues synchronisées : la durée est
 * répartie proportionnellement au poids de chaque phrase dans la scène.
 *
 * Task 106-b — `realNarrationDurationSec` (durée ffprobe RÉELLE de la
 * narration de la scène, optionnel) : si fournie, la fenêtre des cues se
 * borne à [startSec, startSec + min(réel, durationSec)] — les cues
 * suivent la voix réelle au lieu d'être étirées jusqu'à la fin théorique
 * de la scène (une narration plus courte que la scène ne décale plus les
 * sous-titres). La répartition INTERNE reste proportionnelle au nombre
 * de caractères (meilleure estimation disponible par phrase). Absent →
 * comportement historique strictement inchangé.
 */
export function buildCuesForScene(scene: ScriptScene, realNarrationDurationSec?: number): SubtitleCue[] {
  if (!scene.narration.trim() || !scene.captions) return [];
  const phrases = splitPhrases(scene.narration);
  if (phrases.length === 0) return [];

  const realSec =
    typeof realNarrationDurationSec === "number" && Number.isFinite(realNarrationDurationSec) && realNarrationDurationSec > 0
      ? realNarrationDurationSec
      : null;
  // Fenêtre effective : la narration réelle, plafonnée par la scène.
  const windowSec = realSec !== null ? Math.min(realSec, scene.durationSec) : scene.durationSec;

  const weights = phrases.map((p) => Math.max(p.length, 8));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const cues: SubtitleCue[] = [];
  let cursor = scene.startSec;
  const sceneEnd = scene.startSec + windowSec;

  phrases.forEach((phrase, i) => {
    let duration = (weights[i] / totalWeight) * windowSec;
    duration = Math.min(MAX_CUE_SEC, Math.max(MIN_CUE_SEC, duration));
    const end = Math.min(sceneEnd, cursor + duration);
    if (cursor >= sceneEnd) return;
    cues.push({
      startSec: round2(cursor),
      endSec: round2(end),
      text: wrapText(phrase),
      emphasis: emphasize(phrase),
    });
    cursor = end;
  });

  // Bouche les trous : la dernière cue finit exactement à la fin de la
  // fenêtre (fin de la narration réelle, sinon fin de scène).
  if (cues.length > 0) cues[cues.length - 1].endSec = round2(sceneEnd);
  return cues;
}

function splitPhrases(narration: string): string[] {
  return narration
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…])\s+|(?<=,)\s+(?=(?:mais|donc|or|car|ni|que|puis|ensuite))|(?<=[:;])\s+/i)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (p.length > MAX_LINE_CHARS * MAX_LINES * 1.4 ? splitLongPhrase(p) : [p]));
}

function splitLongPhrase(phrase: string): string[] {
  const words = phrase.split(" ");
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > MAX_LINE_CHARS * MAX_LINES) {
      if (current) chunks.push(current.trim());
      current = word;
    } else {
      current = `${current} ${word}`.trim();
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Coupure en ≤2 lignes équilibrées. */
function wrapText(text: string): string {
  if (text.length <= MAX_LINE_CHARS) return text;
  const words = text.split(" ");
  const line1: string[] = [];
  const line2: string[] = [];
  let switched = false;
  for (const word of words) {
    const target = switched ? line2 : line1;
    if (!switched && (line1.join(" ") + " " + word).trim().length > Math.min(MAX_LINE_CHARS, Math.ceil(text.length / 2))) {
      switched = true;
      line2.push(word);
    } else {
      target.push(word);
    }
  }
  return `${line1.join(" ")}\n${line2.join(" ")}`;
}

/** Mots « importants » : chiffres, majuscules significatives, mots longs rares. */
function emphasize(phrase: string): string[] {
  return phrase
    .split(/\s+/)
    .filter((w) => /\d/.test(w) || (w.length >= 9 && /^[A-Za-zÀ-ÿ]+$/.test(w)))
    .slice(0, 3);
}

/**
 * Construit la piste complète de sous-titres du projet.
 * Task 106-b — `realNarrationDurationByScene` (optionnel) : durées de
 * narration réelles (ffprobe) par scène — les cues sont ancrées sur la
 * voix réelle. Absent → comportement inchangé. Alimenté au branchement
 * final par l'orchestrateur (les probes audio sont disponibles dans le
 * render-queue au stade plan, via asset.media.durationSec).
 */
export function buildSubtitleTrack(
  scenes: ScriptScene[],
  style: SubtitleStyleName,
  position: "bottom" | "center" | "top",
  realNarrationDurationByScene?: Map<string, number>,
): SubtitleTrackFile {
  return {
    style,
    position,
    cues: scenes.flatMap((s) => buildCuesForScene(s, realNarrationDurationByScene?.get(s.id))),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Génération ASS / SRT — formats réels
// ────────────────────────────────────────────────────────────────────────────

const ASS_HEADER = "[Script Info]\nScriptType: v4.00+\nPlayResX: {W}\nPlayResY: {H}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n";

interface AssStyle {
  fontsize: number;
  primary: string;   // &HAABBGGRR
  outline: string;
  back: string;
  bold: number;
  outlineWidth: number;
  shadow: number;
  alignment: number; // numpad : 2=bas centre, 5=milieu, 8=haut
  marginV: number;
}

const STYLE_TABLE: Record<SubtitleStyleName, AssStyle> = {
  documentary: { fontsize: 54, primary: "&H00FFFFFF", outline: "&H80000000", back: "&H60000000", bold: 0, outlineWidth: 2, shadow: 1, alignment: 2, marginV: 60 },
  minimal: { fontsize: 46, primary: "&H00F0F0F0", outline: "&H90000000", back: "&H40000000", bold: 0, outlineWidth: 1, shadow: 0, alignment: 2, marginV: 50 },
  shorts_bold: { fontsize: 72, primary: "&H00FFFFFF", outline: "&H00000000", back: "&H00000000", bold: 1, outlineWidth: 4, shadow: 2, alignment: 5, marginV: 0 },
  cinematic_yellow: { fontsize: 58, primary: "&H0000D7FF", outline: "&HC0000000", back: "&H60000000", bold: 1, outlineWidth: 3, shadow: 1, alignment: 2, marginV: 80 },
};

function alignmentFor(position: "bottom" | "center" | "top"): number {
  return position === "center" ? 5 : position === "top" ? 8 : 2;
}

/** Génère un fichier ASS complet (style + cues), prêt à être brûlé. */
export function toAssFile(track: SubtitleTrackFile, width: number, height: number, fps = 30): string {
  const style = STYLE_TABLE[track.style] ?? STYLE_TABLE.documentary;
  const alignment = track.position === "bottom" || track.position === "center" || track.position === "top" ? alignmentFor(track.position) : style.alignment;
  const header = ASS_HEADER.replace("{W}", String(width)).replace("{H}", String(height)) +
    `Style: Default,DejaVu Sans,${style.fontsize},${style.primary},&H000000FF,${style.outline},${style.back},${style.bold},0,0,0,100,100,0,0,1,${style.outlineWidth},${style.shadow},${alignment},60,60,${style.marginV},1\n\n` +
    "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
  const events = track.cues
    .map((cue) => {
      const text = cue.text.replace(/\n/g, "\\N");
      return `Dialogue: 0,${assTime(cue.startSec)},${assTime(cue.endSec)},Default,,0,0,0,,${text}`;
    })
    .join("\n");
  void fps;
  return `${header}${events}\n`;
}

function assTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

/** Export SRT (plateformes : YouTube upload, réseaux). */
export function toSrtFile(track: SubtitleTrackFile): string {
  return track.cues
    .map((cue, i) => `${i + 1}\n${srtTime(cue.startSec)} --> ${srtTime(cue.endSec)}\n${cue.text}`)
    .join("\n\n") + "\n";
}

function srtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
