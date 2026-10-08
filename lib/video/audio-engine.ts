import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 11 : Audio Engine (spec §11).
 *
 * Un VRAI moteur audio : narration (gain, égalisation, normalisation,
 * pauses), musique (introduction, fond, transition, conclusion), effets
 * sonores et DUCKING — lorsque quelqu'un parle, la musique baisse
 * automatiquement.
 *
 * Musique et SFX : les médias importés par l'utilisateur sont utilisés
 * tels quels ; à défaut, le moteur SYNTHÉTISE des lits musicaux ambiants
 * et des SFX procéduraux réels (FFmpeg : oscillateurs, bruit filtré,
 * enveloppes) mis en cache par ambiance/nom — de vrais fichiers audio
 * générés, pas des références fictives.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioItem, AudioMixPlan, SfxName, ScriptScene, VideoProject, VideoTimeline, VideoAsset } from "@/lib/video/types";
import { registerAsset, listAssets } from "@/lib/video/asset-service";
import { runFfmpeg } from "@/lib/video/ffmpeg";

// ────────────────────────────────────────────────────────────────────────────
// SFX procéduraux — synthèse FFmpeg réelle, cache par nom
// ────────────────────────────────────────────────────────────────────────────

/** Recette FFmpeg par SFX (oscillateurs/bruit + enveloppes), sortie WAV. */
const SFX_RECIPES: Record<SfxName, { args: (out: string) => string[]; durationSec: number }> = {
  whoosh: {
    durationSec: 0.9,
    args: (out) => [
      "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.5:duration=0.9",
      "-af", "lowpass=f=1200,highpass=f=200,afade=t=in:d=0.25,afade=t=out:st=0.45:d=0.45,volume=1.4",
      "-t", "0.9", out,
    ],
  },
  impact: {
    durationSec: 1.2,
    args: (out) => [
      "-f", "lavfi", "-i", "sine=frequency=55:duration=1.2",
      "-af", "volume=2.2,alimiter=limit=0.9,afade=t=out:st=0.3:d=0.9",
      "-t", "1.2", out,
    ],
  },
  click: {
    durationSec: 0.12,
    args: (out) => [
      "-f", "lavfi", "-i", "sine=frequency=1800:duration=0.12",
      "-af", "afade=t=out:d=0.1,volume=0.9",
      "-t", "0.12", out,
    ],
  },
  ambient: {
    durationSec: 12,
    args: (out) => [
      "-f", "lavfi", "-i", "anoisesrc=color=brown:amplitude=0.25:duration=12",
      "-af", "lowpass=f=500,volume=1.1",
      "-t", "12", out,
    ],
  },
  cinematic_hit: {
    durationSec: 2.0,
    args: (out) => [
      "-f", "lavfi", "-i", "sine=frequency=40:duration=2",
      "-f", "lavfi", "-i", "anoisesrc=color=white:amplitude=0.3:duration=2",
      "-filter_complex", "[0:a]volume=2,afade=t=out:st=0.4:d=1.6[a];[1:a]lowpass=f=800,afade=t=out:st=0.1:d=1.6[b];[a][b]amix=inputs=2:duration=longest,volume=1.6,alimiter=limit=0.9",
      "-t", "2", out,
    ],
  },
  riser: {
    durationSec: 2.0,
    args: (out) => [
      "-f", "lavfi", "-i", "sine=frequency=200:duration=2",
      "-af", "asetrate=44100*1.5,aresample=44100,afade=t=in:d=1.7,lowpass=f=2400,volume=1.2",
      "-t", "2", out,
    ],
  },
  sub_bass: {
    durationSec: 1.5,
    args: (out) => [
      "-f", "lavfi", "-i", "sine=frequency=30:duration=1.5",
      "-af", "volume=2.5,alimiter=limit=0.85,afade=t=out:st=0.4:d=1.1",
      "-t", "1.5", out,
    ],
  },
};

/** Génère (ou retrouve) le SFX demandé pour le projet. */
export async function ensureSfxAsset(userId: string, projectId: string, name: SfxName): Promise<VideoAsset> {
  const existing = await listAssets(userId, projectId, "audio_sfx");
  const cached = existing.find((a) => a.role === `sfx:${name}`);
  if (cached) return cached;

  const recipe = SFX_RECIPES[name];
  const dir = await mkdtemp(join(tmpdir(), "gen3ia-sfx-"));
  try {
    const outPath = join(dir, `sfx_${name}.wav`);
    await runFfmpeg({
      args: [...recipe.args(outPath)],
      cwd: dir,
      outputDurationSec: recipe.durationSec,
      outputPaths: [outPath],
    });
    const body = await readFile(outPath);
    return await registerAsset({
      userId,
      projectId,
      kind: "audio_sfx",
      label: `SFX ${name}`,
      role: `sfx:${name}`,
      origin: "library",
      contentType: "audio/wav",
      body,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Lits musicaux — synthèse ambiante par ambiance
// ────────────────────────────────────────────────────────────────────────────

export const MUSIC_MOODS = [
  "cinematographique",
  "documentaire",
  "tension",
  "energique",
  "emotionnel",
  "neutre",
] as const;
export type MusicMood = (typeof MUSIC_MOODS)[number];

export function normalizeMood(mood?: string): MusicMood {
  const lower = (mood ?? "").toLowerCase();
  for (const candidate of MUSIC_MOODS) {
    if (lower.includes(candidate.slice(0, 5))) return candidate;
  }
  if (lower.includes("tense") || lower.includes("suspens")) return "tension";
  if (lower.includes("warm") || lower.includes("chaleu")) return "emotionnel";
  if (lower.includes("energ")) return "energique";
  return "documentaire";
}

interface MoodRecipe {
  freqs: number[];
  noise: "brown" | "pink";
  amplitude: number;
  lowpass: number;
  wobbleHz: number;
}

const MOOD_RECIPES: Record<MusicMood, MoodRecipe> = {
  cinematographique: { freqs: [110, 164.81, 220], noise: "brown", amplitude: 0.16, lowpass: 900, wobbleHz: 0.15 },
  documentaire: { freqs: [130.81, 196, 261.63], noise: "pink", amplitude: 0.12, lowpass: 1200, wobbleHz: 0.2 },
  tension: { freqs: [98, 103.83], noise: "brown", amplitude: 0.2, lowpass: 700, wobbleHz: 0.5 },
  energique: { freqs: [146.83, 220, 293.66], noise: "pink", amplitude: 0.18, lowpass: 2000, wobbleHz: 1.2 },
  emotionnel: { freqs: [87.31, 130.81, 174.61], noise: "pink", amplitude: 0.14, lowpass: 800, wobbleHz: 0.1 },
  neutre: { freqs: [110, 220], noise: "pink", amplitude: 0.1, lowpass: 1000, wobbleHz: 0.25 },
};

/**
 * Génère (ou retrouve) un lit musical de la durée demandée pour l'ambiance
 * donnée. Accords superposés + trémolo léger + bruit filtré : un vrai lit
 * ambient exploitable, synthétisé localement, mis en cache par projet.
 */
export async function ensureMusicBed(
  userId: string,
  projectId: string,
  mood: string,
  durationSec: number,
): Promise<VideoAsset> {
  const normalized = normalizeMood(mood);
  const targetSec = Math.min(Math.max(10, Math.ceil(durationSec)), 600);
  const existing = await listAssets(userId, projectId, "audio_music");
  const cached = existing.find((a) => a.role === `music:${normalized}`);
  if (cached) return cached;

  const recipe = MOOD_RECIPES[normalized];
  const dir = await mkdtemp(join(tmpdir(), "gen3ia-music-"));
  try {
    const outPath = join(dir, `bed_${normalized}.wav`);
    const inputs = recipe.freqs
      .map((f) => ["-f", "lavfi", "-i", `sine=frequency=${f}:duration=${targetSec}`])
      .flat();
    const toneInputs = recipe.freqs.map((_, i) => `[${i}:a]`).join("");
    const noiseIndex = recipe.freqs.length;
    const filterComplex = [
      `${toneInputs}amix=inputs=${recipe.freqs.length}:duration=longest,tremolo=f=${recipe.wobbleHz}:d=0.3,lowpass=f=${recipe.lowpass},volume=${recipe.amplitude}[tone]`,
      `[${noiseIndex}:a]highpass=f=80,lowpass=f=400[noise]`,
    ].join(";");
    await runFfmpeg({
      args: [
        ...inputs,
        "-f", "lavfi", "-i", `anoisesrc=color=${recipe.noise}:amplitude=${recipe.amplitude * 0.6}:duration=${targetSec}`,
        "-filter_complex", `${filterComplex};[tone][noise]amix=inputs=2:duration=longest,afade=t=in:d=2,afade=t=out:st=${Math.max(0, targetSec - 3)}:d=3,alimiter=limit=0.7`,
        "-ac", "2", "-ar", "44100",
        "-t", String(targetSec),
        outPath,
      ],
      cwd: dir,
      outputDurationSec: targetSec,
      outputPaths: [outPath],
    });
    const body = await readFile(outPath);
    return await registerAsset({
      userId,
      projectId,
      kind: "audio_music",
      label: `Musique ${normalized} (${Math.round(targetSec)}s)`,
      role: `music:${normalized}`,
      origin: "library",
      contentType: "audio/wav",
      body,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Plan de mixage — narration + musique + SFX + ducking
// ────────────────────────────────────────────────────────────────────────────

export interface AudioPlanInput {
  project: VideoProject;
  timeline: VideoTimeline;
  /** Asset narration par scène (absent → silence synchronisé). */
  narrationByScene: Map<string, VideoAsset>;
  sfxAssetByName: Map<SfxName, VideoAsset>;
  musicBedAsset?: VideoAsset;
  /**
   * Task 106-b — MUSIQUE PAR SCÈNE : lits musicaux par ambiance (mood),
   * préparés en amont par ensureMusicBedsForScenes() (buildRenderPlan/
   * buildAudioMixPlan restent SYNCHRONES). Fourni et non vide → un item
   * musique par groupe de scènes consécutives partageant le même mood,
   * avec crossfade ~1 s aux jonctions. Absent → lit unique historique.
   */
  musicBedsByMood?: Map<string, VideoAsset>;
}

/** Groupe de scènes consécutives partageant la même ambiance musicale. */
export interface SceneMoodGroup {
  mood: MusicMood;
  startSec: number;
  durationSec: number;
  sceneIds: string[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Task 106-b — groupe les scènes CONSÉCUTIVES partageant le même mood.
 * Mood par scène (scene.musicMood), à défaut project.musicMood, à défaut
 * la normalisation par défaut ("documentaire"). Les groupes servent à
 * poser un lit musical par segment temporel avec crossfade aux jonctions.
 * Fonction PURE (testée dans video-modules.test.ts).
 */
export function groupConsecutiveMoods(scenes: ScriptScene[], projectMood?: string): SceneMoodGroup[] {
  const groups: SceneMoodGroup[] = [];
  for (const scene of scenes) {
    const mood = normalizeMood(scene.musicMood ?? projectMood);
    const start = Math.max(0, Number.isFinite(scene.startSec) ? scene.startSec : 0);
    const duration = Math.max(0.5, Number.isFinite(scene.durationSec) ? scene.durationSec : 0.5);
    const last = groups[groups.length - 1];
    if (last && last.mood === mood) {
      // Fusion : le groupe s'étend jusqu'à la fin de cette scène.
      last.durationSec = round2(Math.max(last.durationSec, start + duration - last.startSec));
      last.sceneIds.push(scene.id);
    } else {
      groups.push({ mood, startSec: round2(start), durationSec: round2(duration), sceneIds: [scene.id] });
    }
  }
  return groups;
}

/**
 * Task 106-b — prépare les lits musicaux PAR AMBIANCE : un ensureMusicBed()
 * par mood distinct (durée = celle du groupe ; cache réel par rôle
 * `music:<mood>` côté Media Library). À appeler AVANT buildRenderPlan,
 * puis brancher le résultat sur musicBedsByMood (BuildPlanInput /
 * AudioPlanInput). Les scenes peuvent être passées explicitement (révision
 * ciblée) — à défaut, celles du scénario du projet.
 */
export async function ensureMusicBedsForScenes(params: {
  userId: string;
  project: VideoProject;
  scenes?: ScriptScene[];
}): Promise<Map<MusicMood, VideoAsset>> {
  const scenes = params.scenes ?? params.project.script?.scenes ?? [];
  const groups = groupConsecutiveMoods(scenes, params.project.musicMood);
  const beds = new Map<MusicMood, VideoAsset>();
  for (const group of groups) {
    if (beds.has(group.mood)) continue; // un seul asset par mood (cache)
    beds.set(group.mood, await ensureMusicBed(params.userId, params.project.id, group.mood, group.durationSec));
  }
  return beds;
}

/**
 * Construit le plan de mixage complet du rendu : items narration alignés
 * sur leurs scènes, musique en fond continue, SFX aux transitions, avec
 * ducking automatique pendant la parole (la musique baisse quand quelqu'un
 * parle — spec §11).
 *
 * Task 106-b — MUSIQUE PAR SCÈNE : quand `musicBedsByMood` est fourni (et
 * non vide), la musique devient MULTI-LITS — un item par groupe de scènes
 * consécutives partageant le même mood (groupConsecutiveMoods), posé à la
 * fenêtre du groupe, crossfade ~1 s aux jonctions entre groupes, fondus
 * élargis aux extrémités (convention du lit unique). Mood par défaut =
 * project.musicMood. Si aucun groupe ne trouve son asset, repli sur le
 * lit unique historique (musicBedAsset) — comportement inchangé.
 */
export function buildAudioMixPlan(input: AudioPlanInput): AudioMixPlan {
  const { project, timeline } = input;
  const narration: AudioItem[] = [];
  const sfx: AudioItem[] = [];

  for (const scene of project.script?.scenes ?? []) {
    const asset = input.narrationByScene.get(scene.id);
    if (asset) {
      narration.push({
        id: `narr_${scene.id}`,
        assetId: asset.id,
        startSec: scene.startSec,
        durationSec: Math.min(scene.durationSec, asset.media?.durationSec ?? scene.durationSec),
        volume: 1,
        fadeInSec: 0.1,
        fadeOutSec: 0.15,
        eq: { highpassHz: 90 },
      });
    }
    // SFX d'entrée de scène (posés légèrement avant la coupe).
    scene.soundEffects.forEach((name, i) => {
      const sfxAsset = input.sfxAssetByName.get(name);
      if (!sfxAsset) return;
      sfx.push({
        id: `sfx_${scene.id}_${i}`,
        assetId: sfxAsset.id,
        startSec: Math.max(0, scene.startSec - 0.15 + i * 0.1),
        durationSec: sfxAsset.media?.durationSec ?? 1,
        volume: 0.8,
        fadeInSec: 0.01,
        fadeOutSec: 0.2,
      });
    });
  }

  const music: AudioItem[] = [];
  const moodGroups = input.musicBedsByMood && input.musicBedsByMood.size > 0
    ? groupConsecutiveMoods(project.script?.scenes ?? [], project.musicMood)
    : [];
  const multiBeds: AudioItem[] = [];
  moodGroups.forEach((group, i) => {
    const asset = input.musicBedsByMood?.get(group.mood);
    if (!asset) return; // mood sans asset préparé : groupe sauté
    multiBeds.push({
      id: `music_bed_${group.mood}_${i}`,
      assetId: asset.id,
      startSec: group.startSec,
      durationSec: group.durationSec,
      volume: timeline.musicBed?.volume ?? 0.6,
      // Crossfade ~1 s aux jonctions entre groupes ; fondus élargis aux
      // extrémités (convention du lit unique historique : 1.5 s in / 2.5 s out).
      fadeInSec: i === 0 ? 1.5 : 1,
      fadeOutSec: i === moodGroups.length - 1 ? 2.5 : 1,
      eq: { lowpassHz: 9000 },
    });
  });
  if (multiBeds.length > 0) {
    music.push(...multiBeds);
  } else if (input.musicBedAsset) {
    // Lit unique historique (comportement inchangé).
    music.push({
      id: "music_bed",
      assetId: input.musicBedAsset.id,
      startSec: 0,
      durationSec: Math.min(timeline.durationSec, input.musicBedAsset.media?.durationSec ?? timeline.durationSec),
      volume: timeline.musicBed?.volume ?? 0.6,
      fadeInSec: 1.5,
      fadeOutSec: 2.5,
      eq: { lowpassHz: 9000 },
    });
  }

  return {
    narration,
    music,
    sfx,
    ducking: {
      enabled: narration.length > 0 && music.length > 0,
      nominalVolume: timeline.musicBed?.volume ?? 0.6,
      duckedVolume: timeline.musicBed?.duckTo ?? 0.22,
      attackSec: 0.4,
      releaseSec: 0.8,
    },
    targetLoudnessDb: -16,
  };
}

/** Prépare en une passe tous les éléments audio d'un projet (narrations absentes ignorées). */
export async function ensureAudioAssetsForProject(params: {
  userId: string;
  project: VideoProject;
  mood?: string;
  totalDurationSec: number;
  neededSfx: SfxName[];
}): Promise<{ musicBed?: VideoAsset; sfxByName: Map<SfxName, VideoAsset> }> {
  const sfxByName = new Map<SfxName, VideoAsset>();
  for (const name of [...new Set(params.neededSfx)]) {
    sfxByName.set(name, await ensureSfxAsset(params.userId, params.project.id, name));
  }
  const mood = params.mood ?? params.project.musicMood ?? "documentaire";
  const musicBed = await ensureMusicBed(params.userId, params.project.id, mood, params.totalDurationSec);
  return { musicBed, sfxByName };
}
