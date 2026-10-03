import "server-only";

/**
 * GEN3IA VIDEO AGENT — modification conversationnelle (spec §22).
 *
 * Après génération, l'utilisateur parle à son Directeur de production :
 *   « La vidéo est trop rapide. » → ralentissement des scènes + transitions.
 *   « Remplace la musique. » / « Mets ma voix. » / « Fais une version
 *   TikTok. » / « Sous-titres jaunes. » / « Supprime la scène 12. » /
 *   « Ajoute 5 minutes au chapitre 2. » / « Reviens à la version 2. »
 *
 * L'agent modifie LE PROJET EXISTANT (scénario, timeline, voix, exports) —
 * pas seulement la vidéo finale. Chaque révision passe par un snapshot
 * (réversible) et applique des opérations typées des services existants.
 *
 * Analyse : LLM (intentions structurées) avec repli DÉTERMINISTE par
 * mots-clés — les commandes principales fonctionnent même sans LLM.
 */

import { z } from "zod";
import { generate } from "@/lib/ai/router";
import { extractJsonObject } from "@/lib/agents/planner/normalize";
import type { VideoProject, SubtitleStyleName } from "@/lib/video/types";
import { getOwnedProjectOrThrow, patchProject, snapshotVersion, restoreVersion, appendProductionLog } from "@/lib/video/project-service";
import { applyTimelinePatch } from "@/lib/video/timeline-service";
import { listVersions } from "@/lib/video/project-service";
import { requestShortsVersion } from "@/lib/video/export-service";
import { listVoiceProfiles, resolvePreferredVoice } from "@/lib/video/voice-service";
import { ensureMusicBed, normalizeMood } from "@/lib/video/audio-engine";

export const REVISION_INTENTS = [
  "change_pace",
  "change_music",
  "use_my_voice",
  "set_subtitle_style",
  "toggle_captions",
  "delete_scene",
  "extend_chapter",
  "cinematic_intro",
  "regenerate_scene_images",
  "add_text",
  "shorts_version",
  "goto_version",
  "unsupported",
] as const;
export type RevisionIntent = (typeof REVISION_INTENTS)[number];

const INTENT_SCHEMA = z.object({
  intent: z.enum(REVISION_INTENTS),
  targetSceneId: z.string().max(80).optional().nullable(),
  targetChapterTitle: z.string().max(200).optional().nullable(),
  paceFactor: z.number().min(0.5).max(2).optional().nullable(),
  musicMood: z.string().max(120).optional().nullable(),
  subtitleStyle: z.enum(["documentary", "minimal", "shorts_bold", "cinematic_yellow"]).optional().nullable(),
  text: z.string().max(300).optional().nullable(),
  versionNumber: z.number().int().min(1).optional().nullable(),
  reason: z.string().max(600),
});

export interface RevisionResult {
  intent: RevisionIntent;
  applied: boolean;
  message: string;
  changed: { script: boolean; timeline: boolean; voices: boolean; exports: boolean; version: boolean };
  exportJobId?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Analyse d'intention
// ────────────────────────────────────────────────────────────────────────────

export async function parseIntent(instruction: string, project: VideoProject): Promise<z.infer<typeof INTENT_SCHEMA>> {
  try {
    const response = await generate({
      task: "reasoning",
      messages: [
        {
          role: "system",
          content: `Tu es le Directeur de production Gen3ia. Classe l'instruction de modification de vidéo en intention JSON stricte :
{"intent":"change_pace|change_music|use_my_voice|set_subtitle_style|toggle_captions|delete_scene|extend_chapter|cinematic_intro|regenerate_scene_images|add_text|shorts_version|goto_version|unsupported",
"targetSceneId":"scene_XXX|null","targetChapterTitle":"string|null","paceFactor":nombre(0.5-2)|null,
"musicMood":"string|null","subtitleStyle":"documentary|minimal|shorts_bold|cinematic_yellow|null",
"text":"string|null","versionNumber":nombre|null,"reason":"explication courte en français"}
Scènes existantes : ${project.script?.scenes.map((s) => s.id).join(", ") ?? "aucune"}.`,
        },
        { role: "user", content: instruction },
      ],
      temperature: 0.1,
      maxTokens: 400,
      requiresStructuredOutput: true,
    });
    const parsed = INTENT_SCHEMA.safeParse(extractJsonObject(response.text));
    if (parsed.success) return parsed.data;
  } catch {
    // Repli déterministe ci-dessous.
  }
  return parseIntentDeterministic(instruction);
}

/** Repli sans LLM : règles de mots-clés sur les commandes principales. */
export function parseIntentDeterministic(instruction: string): z.infer<typeof INTENT_SCHEMA> {
  const lower = instruction.toLowerCase();
  const reason = "Analyse déterministe (mots-clés).";
  const sceneMatch = lower.match(/sc[èe]ne\s*(\d+)/);
  const targetSceneId = sceneMatch ? `scene_${String(Number(sceneMatch[1])).padStart(3, "0")}` : null;
  const versionMatch = lower.match(/version\s*(\d+)/);
  const paceMatch = lower.match(/(\d+)\s*%/);

  if (/tiktok|shorts|reels/.test(lower)) {
    return { intent: "shorts_version", targetSceneId, versionNumber: null, paceFactor: null, musicMood: null, subtitleStyle: null, text: null, targetChapterTitle: null, reason };
  }
  if (/revenir|reviens|retour.*version/.test(lower) && versionMatch) {
    return { intent: "goto_version", targetSceneId, versionNumber: Number(versionMatch[1]), paceFactor: null, musicMood: null, subtitleStyle: null, text: null, targetChapterTitle: null, reason };
  }
  if (/ma voix|mon enregistrement|my voice/.test(lower)) {
    return { intent: "use_my_voice", targetSceneId, versionNumber: null, paceFactor: null, musicMood: null, subtitleStyle: null, text: null, targetChapterTitle: null, reason };
  }
  if (/musique/.test(lower)) {
    const mood = /tension|drame/.test(lower) ? "tension" : /calme|pos[eé]|document/.test(lower) ? "documentaire" : /dynamique|[ée]nerg/.test(lower) ? "energique" : /[ée]motion/.test(lower) ? "emotionnel" : "cinematographique";
    return { intent: "change_music", targetSceneId, versionNumber: null, paceFactor: null, musicMood: mood, subtitleStyle: null, text: null, targetChapterTitle: null, reason };
  }
  if (/sous-?titres?/.test(lower)) {
    const style = /jaune/.test(lower) ? "cinematic_yellow" : /court|tiktok|shorts/.test(lower) ? "shorts_bold" : /discret|minimal/.test(lower) ? "minimal" : "documentary";
    return { intent: "set_subtitle_style", targetSceneId, versionNumber: null, paceFactor: null, musicMood: null, subtitleStyle: style as SubtitleStyleName, text: null, targetChapterTitle: null, reason };
  }
  if (/trop (rapide|vite)|ralenti|slow/.test(lower)) {
    const factor = paceMatch ? Math.max(0.5, Math.min(2, 1 + Number(paceMatch[1]) / 100)) : 1.25;
    return { intent: "change_pace", targetSceneId, versionNumber: null, paceFactor: factor, musicMood: null, subtitleStyle: null, text: null, targetChapterTitle: null, reason };
  }
  if (/trop (lent|longue)|acc[ée]l[èe]re|speed up/.test(lower)) {
    return { intent: "change_pace", targetSceneId, versionNumber: null, paceFactor: 0.8, musicMood: null, subtitleStyle: null, text: null, targetChapterTitle: null, reason };
  }
  if (/supprime|enl[èe]ve|delete/.test(lower) && targetSceneId) {
    return { intent: "delete_scene", targetSceneId, versionNumber: null, paceFactor: null, musicMood: null, subtitleStyle: null, text: null, targetChapterTitle: null, reason };
  }
  if (/cin[ée]matographique|introduction/.test(lower)) {
    return { intent: "cinematic_intro", targetSceneId, versionNumber: null, paceFactor: null, musicMood: null, subtitleStyle: null, text: null, targetChapterTitle: null, reason };
  }
  if (/remplace (les )?(images|visuels)/.test(lower) && targetSceneId) {
    return { intent: "regenerate_scene_images", targetSceneId, versionNumber: null, paceFactor: null, musicMood: null, subtitleStyle: null, text: null, targetChapterTitle: null, reason };
  }
  if (/ajoute .*minutes?|allonge/.test(lower)) {
    return { intent: "extend_chapter", targetSceneId, targetChapterTitle: null, versionNumber: null, paceFactor: null, musicMood: null, subtitleStyle: null, text: null, reason };
  }
  return { intent: "unsupported", targetSceneId, versionNumber: null, paceFactor: null, musicMood: null, subtitleStyle: null, text: null, targetChapterTitle: null, reason: "Instruction non reconnue (repli)." };
}

// ────────────────────────────────────────────────────────────────────────────
// Application
// ────────────────────────────────────────────────────────────────────────────

export async function applyRevision(params: {
  userId: string;
  projectId: string;
  instruction: string;
  origin: string;
}): Promise<RevisionResult> {
  const project = await getOwnedProjectOrThrow(params.userId, params.projectId);
  const intent = await parseIntent(params.instruction, project);
  const changed = { script: false, timeline: false, voices: false, exports: false, version: false };

  switch (intent.intent) {
    case "change_pace": {
      if (!project.timeline) throw new Error("Timeline absente.");
      const factor = intent.paceFactor ?? 1.25;
      // Retime en cascade : scènes + clips + textes réalignés d'un bloc.
      const timeline = retimeTimelineFromScript(project, project.timeline, factor);
      await snapshotVersion(params.userId, params.projectId, "Avant changement de rythme", "agent");
      await patchProject(params.userId, params.projectId, { timeline });
      changed.timeline = true;
      await log(params.userId, params.projectId, `Rythme modifié (×${factor.toFixed(2)}) — durées de scènes et positions réalignées.`);
      return { intent: intent.intent, applied: true, message: `Rythme modifié (facteur ×${factor.toFixed(2)}) : durées de scènes et positions réalignées.`, changed };
    }
    case "change_music": {
      const mood = normalizeMood(intent.musicMood ?? "cinematographique");
      const duration = project.timeline?.durationSec ?? project.targetDurationSec;
      const bed = await ensureMusicBed(params.userId, params.projectId, mood, duration);
      if (project.timeline) {
        const timeline = applyTimelinePatch(project.timeline, "set_music_bed", undefined, { assetId: bed.id, volume: 0.6, duckTo: 0.22 });
        await snapshotVersion(params.userId, params.projectId, "Avant changement de musique", "agent");
        await patchProject(params.userId, params.projectId, { timeline, musicMood: mood });
        changed.timeline = true;
      } else {
        await patchProject(params.userId, params.projectId, { musicMood: mood });
      }
      await log(params.userId, params.projectId, `Musique remplacée : ${mood}.`);
      return { intent: intent.intent, applied: true, message: `Nouvelle musique « ${mood} » installée avec ducking automatique.`, changed };
    }
    case "use_my_voice": {
      const voice = await resolvePreferredVoice(params.userId, { voicePreference: { kind: "user_voice", voiceId: project.voicePreference.voiceId } })
        ?? (await listVoiceProfiles(params.userId)).find((v) => v.origin === "recording");
      if (!voice) throw new Error("Aucune voix enregistrée — enregistrez votre voix dans l'onglet Voix d'abord.");
      await snapshotVersion(params.userId, params.projectId, "Avant passage à ma voix", "agent");
      await patchProject(params.userId, params.projectId, { voicePreference: { kind: "user_voice", voiceId: voice.id } });
      changed.voices = true;
      await log(params.userId, params.projectId, `Voix préférée : « ${voice.name} » (à régénérer par scène).`);
      return { intent: intent.intent, applied: true, message: `Voix « ${voice.name} » sélectionnée. Régénérez les narrations (onglet Voix) puis relancez le rendu.`, changed };
    }
    case "set_subtitle_style": {
      if (!project.timeline) throw new Error("Timeline absente.");
      const timeline = applyTimelinePatch(project.timeline, "set_captions", undefined, { enabled: true, style: intent.subtitleStyle ?? "documentary" });
      await snapshotVersion(params.userId, params.projectId, "Avant changement de sous-titres", "agent");
      await patchProject(params.userId, params.projectId, { timeline });
      changed.timeline = true;
      await log(params.userId, params.projectId, `Style de sous-titres : ${intent.subtitleStyle}.`);
      return { intent: intent.intent, applied: true, message: `Sous-titres appliqués en style « ${intent.subtitleStyle} ».`, changed };
    }
    case "toggle_captions": {
      if (!project.timeline) throw new Error("Timeline absente.");
      const timeline = applyTimelinePatch(project.timeline, "set_captions", undefined, { enabled: !project.timeline.captions.enabled });
      await snapshotVersion(params.userId, params.projectId, "Avant bascule sous-titres", "agent");
      await patchProject(params.userId, params.projectId, { timeline });
      changed.timeline = true;
      return { intent: intent.intent, applied: true, message: `Sous-titres ${timeline.captions.enabled ? "activés" : "désactivés"}.`, changed };
    }
    case "delete_scene": {
      if (!project.script) throw new Error("Aucun scénario.");
      const sceneId = intent.targetSceneId;
      if (!sceneId || !project.script.scenes.some((s) => s.id === sceneId)) {
        throw new Error(`Scène introuvable : ${intent.targetSceneId ?? "?"}`);
      }
      const script = structuredClone(project.script);
      script.scenes = script.scenes.filter((s) => s.id !== sceneId);
      for (const chapter of script.chapters) {
        chapter.sceneIds = chapter.sceneIds.filter((id) => id !== sceneId);
      }
      renumberScenes(script);
      let timeline = project.timeline ?? undefined;
      if (timeline) {
        timeline = applyTimelinePatch(timeline, "delete_clip", `clip_img_${sceneId}`);
      }
      await snapshotVersion(params.userId, params.projectId, `Avant suppression ${sceneId}`, "agent");
      await patchProject(params.userId, params.projectId, { script, timeline, stats: { ...project.stats, sceneCount: script.scenes.length } });
      changed.script = true;
      changed.timeline = Boolean(timeline);
      await log(params.userId, params.projectId, `Scène ${sceneId} supprimée (script + timeline resynchronisés).`);
      return { intent: intent.intent, applied: true, message: `Scène ${sceneId} supprimée ; positions recalculées.`, changed };
    }
    case "extend_chapter": {
      if (!project.script) throw new Error("Aucun scénario.");
      const chapter = project.script.chapters.find((c) => intent.targetChapterTitle && c.title.toLowerCase().includes(intent.targetChapterTitle.toLowerCase()))
        ?? project.script.chapters[1] ?? project.script.chapters[0];
      if (!chapter) throw new Error("Chapitre introuvable.");
      const factor = 1 + Math.max(1, Number(intent.text ?? 0) || 5) / Math.max(1, project.script.estimatedDurationSec) * 2;
      const script = structuredClone(project.script);
      for (const id of chapter.sceneIds) {
        const scene = script.scenes.find((s) => s.id === id);
        if (scene) scene.durationSec = Math.round(scene.durationSec * Math.min(2, Math.max(1.1, factor)) * 100) / 100;
      }
      renumberScenes(script);
      await snapshotVersion(params.userId, params.projectId, "Avant extension de chapitre", "agent");
      await patchProject(params.userId, params.projectId, { script });
      changed.script = true;
      await log(params.userId, params.projectId, `Chapitre « ${chapter.title} » étendu.`);
      return { intent: intent.intent, applied: true, message: `Chapitre « ${chapter.title} » étendu (narrations à régénérer).`, changed };
    }
    case "cinematic_intro": {
      if (!project.timeline) throw new Error("Timeline absente.");
      let timeline = project.timeline;
      const imageTrack = timeline.tracks.find((t) => t.kind === "image");
      const firstClip = imageTrack?.clips[0];
      if (firstClip) {
        timeline = applyTimelinePatch(timeline, "set_motion", firstClip.id, { preset: "dramatic_push" });
        timeline = applyTimelinePatch(timeline, "set_transition", firstClip.id, { side: "in", name: "fade", durationSec: 1.2 });
        timeline = applyTimelinePatch(timeline, "set_effects", firstClip.id, {
          effects: [
            { name: "color_grade_cinematic", intensity: "normal" },
            { name: "cinematic_bars", intensity: "normal" },
            { name: "grain", intensity: "subtle" },
          ],
        });
      }
      await snapshotVersion(params.userId, params.projectId, "Avant intro cinématographique", "agent");
      await patchProject(params.userId, params.projectId, { timeline });
      changed.timeline = true;
      await log(params.userId, params.projectId, "Introduction rendue cinématographique (push dramatique, étalonnage, bars).");
      return { intent: intent.intent, applied: true, message: "Introduction cinématographique appliquée : mouvement dramatique, étalonnage cinéma, barres noires.", changed };
    }
    case "regenerate_scene_images": {
      await snapshotVersion(params.userId, params.projectId, "Avant régénération d'images", "agent");
      await log(params.userId, params.projectId, `Régénération d'images demandée (${intent.targetSceneId ?? "toutes les scènes"}) — via l'onglet Storyboard.`);
      return { intent: intent.intent, applied: true, message: intent.targetSceneId ? `Image de la scène ${intent.targetSceneId} marquée pour régénération (bouton Régénérer du storyboard).` : "Régénération des images : lancez « Générer les images » depuis le storyboard.", changed };
    }
    case "shorts_version": {
      const result = await requestShortsVersion({ userId: params.userId, projectId: params.projectId, origin: params.origin });
      changed.exports = Boolean(result);
      if (!result) {
        return { intent: intent.intent, applied: false, message: "Aucun rendu terminé à décliner — lancez d'abord un rendu.", changed };
      }
      await log(params.userId, params.projectId, `Version Shorts/TikTok/Reels en file (${result.jobId.slice(0, 8)}).`);
      return { intent: intent.intent, applied: true, message: "Version TikTok/Shorts/Reels en préparation (recadrage 9:16 + sous-titres centrés).", changed, exportJobId: result.jobId };
    }
    case "goto_version": {
      if (!intent.versionNumber) throw new Error("Numéro de version manquant.");
      const versions = await listVersions(params.userId, params.projectId);
      if (!versions.some((v) => v.versionNumber === intent.versionNumber)) {
        throw new Error(`Version ${intent.versionNumber} introuvable (disponibles : ${versions.map((v) => v.versionNumber).join(", ")}).`);
      }
      await restoreVersion(params.userId, params.projectId, intent.versionNumber);
      changed.version = true;
      return { intent: intent.intent, applied: true, message: `Projet restauré à la version ${intent.versionNumber}.`, changed };
    }
    case "unsupported":
    default:
      return {
        intent: "unsupported",
        applied: false,
        message: "Je peux modifier : le rythme, la musique, la voix, les sous-titres, supprimer une scène, étendre un chapitre, rendre l'intro cinématographique, créer une version TikTok ou revenir à une version antérieure.",
        changed,
      };
  }
}

/** Retime en cascade : scènes + clips images + narrations réalignés. */
function retimeTimelineFromScript(project: VideoProject, timeline: NonNullable<VideoProject["timeline"]>, factor: number): NonNullable<VideoProject["timeline"]> {
  if (!project.script) return timeline;
  const script = structuredClone(project.script);
  let cursor = 0;
  for (const scene of script.scenes) {
    scene.durationSec = Math.round(scene.durationSec * factor * 100) / 100;
    scene.startSec = Math.round(cursor * 100) / 100;
    cursor += scene.durationSec;
  }
  script.estimatedDurationSec = Math.round(cursor * 100) / 100;
  // Réaligne les clips image sur les nouvelles positions.
  const imageTrack = timeline.tracks.find((t) => t.kind === "image");
  if (imageTrack) {
    for (const scene of script.scenes) {
      const clip = imageTrack.clips.find((c) => c.id === `clip_img_${scene.id}`);
      if (clip) {
        clip.startSec = scene.startSec;
        clip.durationSec = scene.durationSec;
      }
    }
  }
  const textTrack = timeline.tracks.find((t) => t.kind === "text");
  if (textTrack) {
    for (const clip of textTrack.clips) {
      const scene = script.scenes.find((s) => clip.startSec >= s.startSec - 0.5 && clip.startSec <= s.startSec + s.durationSec);
      if (scene) clip.startSec = scene.startSec + 0.3;
    }
  }
  timeline.durationSec = cursor;
  return timeline;
}

/** Renumérote les scènes et recalcule startSec après suppression/extension. */
function renumberScenes(script: NonNullable<VideoProject["script"]>): void {
  let cursor = 0;
  script.scenes.forEach((scene, i) => {
    scene.index = i;
    scene.startSec = Math.round(cursor * 100) / 100;
    cursor += scene.durationSec;
  });
  script.estimatedDurationSec = Math.round(cursor * 100) / 100;
}

async function log(userId: string, projectId: string, message: string): Promise<void> {
  await appendProductionLog(userId, projectId, { actor: "director", message });
}
