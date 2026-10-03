import "server-only";

/**
 * GEN3IA VIDEO AGENT — modules 3 & 4 : Script Engine + Storyboard Engine
 * (spec §5 et §6).
 *
 * Le Script Engine génère un VRAI scénario structuré (Hook → Introduction →
 * Chapitres → Scènes → Conclusion → CTA), pas un paragraphe. Chaque scène
 * porte sa narration, son prompt visuel, son animation, ses transitions,
 * sa musique, ses SFX et son flag sous-titres.
 *
 * Le Storyboard Engine découpe ensuite la production en scènes horodatées
 * (SCÈNE 01 — 00:00 → 00:07 — image, animation, voix, musique) pour que
 * l'agent sache exactement ce qu'il doit monter.
 */

import { generate } from "@/lib/ai/router";
import { extractJsonObject } from "@/lib/agents/planner/normalize";
import { z } from "zod";
import {
  type ScriptScene,
  type VideoProject,
  type VideoScript,
  type StoryboardEntry,
  MOTION_PRESETS,
  TRANSITION_NAMES,
  SFX_NAMES,
} from "@/lib/video/types";
import { patchProject, snapshotVersion, appendProductionLog, getOwnedProjectOrThrow } from "@/lib/video/project-service";
import { VIDEO_LIMITS } from "@/lib/video/security";
import { buildVisualBibleFromScript } from "@/lib/video/consistency-engine";

// ────────────────────────────────────────────────────────────────────────────
// Contrats de sortie stricts
// ────────────────────────────────────────────────────────────────────────────

const SCENE_SCHEMA = z.object({
  id: z.string().min(1).max(80),
  chapterId: z.string().min(1).max(80),
  durationSec: z.number().min(3).max(60),
  narration: z.string().min(1).max(2000),
  onScreenText: z.string().max(200).optional().nullable(),
  visualPrompt: z.string().min(3).max(1200),
  visualType: z.enum(["image", "video", "screen_recording"]).default("image"),
  cameraMotion: z.enum(MOTION_PRESETS).default("slow_zoom"),
  transitionIn: z.enum(TRANSITION_NAMES).default("fade"),
  transitionOut: z.enum(TRANSITION_NAMES).default("cut"),
  musicMood: z.string().max(120).optional().nullable(),
  soundEffects: z.array(z.enum(SFX_NAMES)).max(6).default([]),
  captions: z.boolean().default(true),
});

const SCRIPT_SCHEMA = z.object({
  hook: z.string().min(3).max(1200),
  introduction: z.string().min(3).max(2400),
  chapters: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        title: z.string().min(1).max(200),
        summary: z.string().max(800),
        sceneIds: z.array(z.string().max(80)).min(1),
      }),
    )
    .min(1)
    .max(60),
  scenes: z.array(SCENE_SCHEMA).min(1).max(VIDEO_LIMITS.maxScenes),
  conclusion: z.string().min(3).max(2000),
  callToAction: z.string().max(600).optional().nullable(),
});

const SCRIPT_SYSTEM_PROMPT = `Tu es le SCRIPT ENGINE de Gen3ia Video Agent. Tu écris de vrais scénarios structurés, pas des paragraphes.
Structure obligatoire : Hook → Introduction → Chapitres (chacun découpé en scènes) → Conclusion → CTA.
Tu réponds STRICTEMENT en JSON :
{
  "hook": string, "introduction": string,
  "chapters": [{"id": string, "title": string, "summary": string, "sceneIds": [string]}],
  "scenes": [{
    "id": string, "chapterId": string, "durationSec": nombre(3-60),
    "narration": string, "onScreenText": string|null,
    "visualPrompt": string (description visuelle précise, EN ANGLAIS pour le modèle d'images),
    "visualType": "image"|"video"|"screen_recording",
    "cameraMotion": "static"|"slow_zoom"|"zoom_out"|"ken_burns"|"pan_left_right"|"pan_right_left"|"tilt_up"|"tilt_down"|"parallax"|"dramatic_push",
    "transitionIn": "cut"|"fade"|"dissolve"|"wipe_left"|"wipe_right"|"slide_left"|"slide_right"|"zoom"|"blur"|"flash"|"glitch"|"circle"|"match",
    "transitionOut": idem, "musicMood": string|null,
    "soundEffects": ["whoosh"|"impact"|"click"|"ambient"|"cinematic_hit"|"riser"|"sub_bass"],
    "captions": boolean
  }],
  "conclusion": string, "callToAction": string|null
}
Règles :
- La somme des durationSec des scènes ≈ durée cible demandée (±10 %).
- Les id de scènes suivent scene_001, scene_002… et chaque sceneIds de chapitre référence des scènes existantes.
- La narration est en ${"langue demandée"} ; les visualPrompt sont en anglais, riches et précis (cadrage, lumière, sujet).
- Transition d'entrée du premier plan = "fade", sortie du dernier = "fade".
- Rythme : scènes de 6 à 10 s pour un documentaire, 3 à 5 s pour un Short.`;

export interface ScriptResult {
  script: VideoScript;
  scenes: ScriptScene[];
}

export async function generateScript(userId: string, projectId: string): Promise<ScriptResult> {
  const project = await getOwnedProjectOrThrow(userId, projectId);
  if (!project.description && project.status === "draft") {
    throw new Error("Renseignez d'abord la demande (description) ou faites établir le plan par le directeur.");
  }

  const chapters = project.status === "planning" && project.description ? project.description : "";
  const sceneTarget = Math.max(3, Math.min(VIDEO_LIMITS.maxScenes, Math.round(project.targetDurationSec / 8)));

  const response = await generate({
    task: "reasoning",
    messages: [
      { role: "system", content: SCRIPT_SYSTEM_PROMPT.replace("langue demandée", project.language) },
      {
        role: "user",
        content: [
          `Sujet : ${project.title}`,
          `Résumé/plan : ${chapters || project.description || project.title}`,
          `Durée cible : ${project.targetDurationSec} secondes (~${sceneTarget} scènes de 6 à 10 s).`,
          `Style : ${project.style}. Public : ${project.audience ?? "grand public"}. Plateforme : ${project.platform ?? "YouTube"}.`,
          `Ton narration attendu : documentaire professionnel. Langue de narration : ${project.language}.`,
          project.musicMood ? `Ambiance musicale : ${project.musicMood}.` : "",
          "Écris le scénario JSON complet.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    temperature: 0.6,
    maxTokens: 8000,
    requiresStructuredOutput: true,
  });

  const parsed = SCRIPT_SCHEMA.safeParse(extractJsonObject(response.text));
  if (!parsed.success) {
    throw new Error(`Scénario invalide renvoyé par le moteur : ${parsed.error.issues.slice(0, 3).map((i) => i.message).join("; ")}`);
  }
  const { script, scenes } = normalizeScript(parsed.data, project);

  await snapshotVersion(userId, projectId, "Avant génération du scénario", "agent");
  await patchProject(userId, projectId, {
    script,
    status: "scripted",
    stats: { ...project.stats, sceneCount: scenes.length },
  });
  await appendProductionLog(userId, projectId, {
    actor: "director",
    message: `Scénario généré : ${script.chapters.length} chapitre(s), ${scenes.length} scènes, ${Math.round(script.estimatedDurationSec)} s estimées.`,
  });
  return { script, scenes };
}

/** Fusionne le contrat brut en script + scènes avec positions calculées. */
function normalizeScript(
  raw: z.infer<typeof SCRIPT_SCHEMA>,
  project: VideoProject,
): ScriptResult {
  const sceneById = new Map<string, ScriptScene>();
  let cursor = 0;
  raw.scenes.forEach((s, i) => {
    const scene: ScriptScene = {
      id: s.id,
      chapterId: s.chapterId,
      index: i,
      durationSec: Math.round(s.durationSec * 100) / 100,
      narration: s.narration,
      onScreenText: s.onScreenText ?? undefined,
      visualPrompt: s.visualPrompt,
      visualType: s.visualType,
      cameraMotion: s.cameraMotion,
      transitionIn: s.transitionIn,
      transitionOut: s.transitionOut,
      musicMood: s.musicMood ?? undefined,
      soundEffects: s.soundEffects,
      captions: s.captions,
      startSec: Math.round(cursor * 100) / 100,
    };
    cursor += scene.durationSec;
    sceneById.set(scene.id, scene);
  });
  const chapters = raw.chapters
    .filter((c) => c.sceneIds.some((id) => sceneById.has(id)))
    .map((c) => ({ ...c, sceneIds: c.sceneIds.filter((id) => sceneById.has(id)) }));
  const allScenes = [...sceneById.values()];
  const script: VideoScript = {
    hook: raw.hook,
    introduction: raw.introduction,
    chapters,
    scenes: allScenes,
    conclusion: raw.conclusion,
    callToAction: raw.callToAction ?? undefined,
    estimatedDurationSec: Math.round(cursor * 100) / 100,
  };
  void project;
  return { script, scenes: allScenes };
}

// ────────────────────────────────────────────────────────────────────────────
// Storyboard Engine
// ────────────────────────────────────────────────────────────────────────────

/**
 * Construit le storyboard horodaté depuis le scénario — déterministe
 * (aucun LLM : le storyboard EST la traduction temporelle du scénario).
 */
export function buildStoryboard(script: VideoScript, scenes: ScriptScene[]): StoryboardEntry[] {
  return scenes.map((scene) => {
    const chapter = script.chapters.find((c) => c.id === scene.chapterId);
    return {
      sceneId: scene.id,
      timecodeStartSec: scene.startSec,
      timecodeEndSec: Math.round((scene.startSec + scene.durationSec) * 100) / 100,
      imageBrief: scene.visualPrompt,
      animation: scene.cameraMotion,
      voiceBrief: truncate(scene.narration, 180),
      musicBrief: scene.musicMood ?? chapter?.summary?.slice(0, 80),
      transitionIn: scene.transitionIn,
    };
  });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export async function generateStoryboard(userId: string, projectId: string): Promise<StoryboardEntry[]> {
  const project = await getOwnedProjectOrThrow(userId, projectId);
  if (!project.script) throw new Error("Générez d'abord le scénario (Script Engine).");
  const scenes = project.script.scenes;
  if (scenes.length === 0) throw new Error("Scénario sans scènes exploitables.");

  const storyboard = buildStoryboard(project.script, project.script.scenes);
  const bible = buildVisualBibleFromScript(project.script, project.script.scenes);
  await snapshotVersion(userId, projectId, "Avant génération du storyboard", "agent");
  await patchProject(userId, projectId, {
    storyboard,
    visualBible: bible,
    status: "storyboarded",
  });
  await appendProductionLog(userId, projectId, {
    actor: "director",
    message: `Storyboard établi (${storyboard.length} scènes horodatées) + bible visuelle du Consistency Engine initialisée.`,
  });
  return storyboard;
}

export function sceneById(project: VideoProject, sceneId: string): ScriptScene | undefined {
  return project.script?.scenes?.find((s) => s.id === sceneId);
}
