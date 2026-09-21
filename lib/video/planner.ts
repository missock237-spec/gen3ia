import { randomUUID } from "node:crypto";

import { z } from "zod";

import { generate } from "@/lib/ai/router";

import { formatHint, type VideoFormat, type VideoScene } from "./types";

/**
 * Planificateur de storyboard du Studio Vidéo :
 *  - planVideoScenes : transforme un brief en scènes structurées (titre,
 *    prompt visuel, narration, texte à l'écran, durée) — JSON strict ;
 *  - editVideoScenes : édition conversationnelle — une instruction en
 *    langage naturel (« remplace le fond par un coucher de soleil ») est
 *    appliquée au storyboard existant par le LLM, qui renvoie le JSON complet.
 */

const PlannedScenesSchema = z.object({
  title: z.string().trim().min(1).max(120),
  scenes: z.array(z.object({
    title: z.string().trim().max(120).default(""),
    durationSeconds: z.number().int().min(2).max(60).default(6),
    visualPrompt: z.string().trim().min(1).max(1_000),
    narration: z.string().trim().max(1_200).default(""),
    onScreenText: z.string().trim().max(300).default(""),
  })).min(1).max(20),
});

const PLANNER_SYSTEM = [
  "Tu es directeur artistique et scénariste vidéo professionnel de la plateforme Gen3ia.",
  "À partir du brief utilisateur, tu produis un storyboard découpé en scènes.",
  "Chaque scène contient : title (court), durationSeconds (2 à 15, réaliste pour le rythme),",
  "visualPrompt (description visuelle DÉTAILLÉE en anglais pour un générateur d'images IA :",
  "sujet, composition, lumière, ambiance, style visuel — sans texte incrusté),",
  "narration (voix off en français, 1 à 2 phrases par scène),",
  "onScreenText (texte court à l'écran, optionnel, en français).",
  "Le storyboard raconte une progression cohérente du début à la fin, adaptée au format demandé.",
  "Réponds STRICTEMENT en JSON : {\"title\":\"...\",\"scenes\":[{\"title\":\"...\",\"durationSeconds\":6,\"visualPrompt\":\"...\",\"narration\":\"...\",\"onScreenText\":\"...\"}]}",
].join(" ");

const EDITOR_SYSTEM = [
  "Tu es monteur vidéo professionnel de la plateforme Gen3ia.",
  "On te donne un storyboard JSON (title + scenes) et une instruction de montage de l'utilisateur.",
  "Tu appliques EXACTEMENT l'instruction au storyboard : modification de prompts visuels, de",
  "narrations, de textes à l'écran, de durées, ajout/suppression/réordonnancement de scènes.",
  "Tu conserves la structure JSON identique (mêmes clés) et les ids de scènes existants ;",
  "les nouvelles scènes reçoivent un id libre. Tu ne réponds JAMAIS en prose.",
  "Réponds STRICTEMENT en JSON : {\"title\":\"...\",\"scenes\":[{\"id\":\"...\",\"title\":\"...\",\"durationSeconds\":6,\"visualPrompt\":\"...\",\"narration\":\"...\",\"onScreenText\":\"...\"}]}",
].join(" ");

/** Extraction JSON robuste (JSON direct, bloc clôturé, ou objet tronqué). */
export function extractJsonBlock(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const candidate of [fenced?.[1]?.trim(), text]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* candidat suivant */ }
      }
    }
  }
  return null;
}

function sanitizePlanned(data: unknown): { title: string; scenes: VideoScene[] } {
  const parsed = PlannedScenesSchema.parse(data);
  return {
    title: parsed.title,
    scenes: parsed.scenes.map((scene) => ({
      id: `scene_${randomUUID().slice(0, 8)}`,
      title: scene.title,
      durationSeconds: scene.durationSeconds,
      visualPrompt: scene.visualPrompt,
      narration: scene.narration,
      onScreenText: scene.onScreenText,
    })),
  };
}

export async function planVideoScenes(params: {
  brief: string;
  format: VideoFormat;
  sceneCount?: number;
}): Promise<{ title: string; scenes: VideoScene[] }> {
  const sceneCount = Math.min(20, Math.max(3, params.sceneCount ?? 6));
  const response = await generate({
    task: "agent",
    messages: [
      { role: "system", content: PLANNER_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          brief: params.brief,
          format: params.format,
          cadrage: formatHint(params.format),
          nombreDeScenes: sceneCount,
        }),
      },
    ],
    requiresStructuredOutput: true,
    preferFree: true,
    maxTokens: 4_000,
    metadata: { purpose: "video-scene-planning" },
  });

  const parsed = extractJsonBlock(response.text);
  if (!parsed) throw new Error("Le planificateur vidéo n'a pas renvoyé de storyboard exploitable. Réessayez.");
  return sanitizePlanned(parsed);
}

export async function editVideoScenes(params: {
  instruction: string;
  title: string;
  format: VideoFormat;
  scenes: VideoScene[];
}): Promise<{ title: string; scenes: VideoScene[] }> {
  const response = await generate({
    task: "agent",
    messages: [
      { role: "system", content: EDITOR_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          instruction: params.instruction,
          format: params.format,
          storyboard: { title: params.title, scenes: params.scenes },
        }),
      },
    ],
    requiresStructuredOutput: true,
    preferFree: true,
    maxTokens: 6_000,
    metadata: { purpose: "video-conversational-edit" },
  });

  const parsed = extractJsonBlock(response.text);
  if (!parsed || typeof parsed !== "object") throw new Error("Le monteur IA n'a pas renvoyé de storyboard exploitable. Reformulez votre instruction.");
  const record = parsed as { title?: unknown; scenes?: unknown };
  const planned = PlannedScenesSchema.parse({
    title: typeof record.title === "string" && record.title.trim() ? record.title : params.title,
    scenes: record.scenes,
  });

  // Conserve les images clés existantes : une scène dont le prompt visuel
  // est strictement inchangé garde son image déjà générée (et déjà facturée).
  const scenes: VideoScene[] = planned.scenes.map((scene) => {
    const previous = params.scenes.find((item) => item.visualPrompt === scene.visualPrompt);
    return {
      id: `scene_${randomUUID().slice(0, 8)}`,
      title: scene.title,
      durationSeconds: scene.durationSeconds,
      visualPrompt: scene.visualPrompt,
      narration: scene.narration,
      onScreenText: scene.onScreenText,
      ...(previous?.keyframePath ? { keyframePath: previous.keyframePath, keyframeFilename: previous.keyframeFilename } : {}),
    };
  });

  return { title: planned.title, scenes };
}
