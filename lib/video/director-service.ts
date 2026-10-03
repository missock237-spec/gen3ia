import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 2 : Video Director Agent (spec §4).
 *
 * C'est le cerveau principal : il transforme une demande libre (« Crée une
 * vidéo documentaire de 30 minutes sur l'évolution de l'IA, destinée à
 * YouTube, en français, style documentaire cinématographique. Utilise ma
 * voix. ») en PLAN DE PRODUCTION complet — durée, format, public, style,
 * structure, narration, musique, sous-titres — puis applique ce plan au
 * projet. Le LLM est encadré par un contrat de sortie strict et des
 * replis déterministes : la plateforme reste utilisable même si le modèle
 * renvoie une réponse incomplète.
 */

import { generate } from "@/lib/ai/router";
import { extractJsonObject } from "@/lib/agents/planner/normalize";
import type { ProductionPlan, VideoProject } from "@/lib/video/types";
import { assertDurationAllowed, assertResolutionAllowed, VIDEO_LIMITS } from "@/lib/video/security";
import { patchProject, snapshotVersion, appendProductionLog } from "@/lib/video/project-service";
import { z } from "zod";

const PLAN_SCHEMA = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(2000),
  language: z.string().min(2).max(10),
  aspectRatio: z.enum(["16:9", "9:16", "1:1", "4:5", "21:9"]),
  resolution: z.enum(["480p", "720p", "1080p", "1440p", "4K"]),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]),
  targetDurationSec: z.number().int().min(VIDEO_LIMITS.minDurationSec).max(VIDEO_LIMITS.maxDurationSec),
  style: z.string().min(2).max(200),
  audience: z.string().max(300).optional().nullable(),
  platform: z.string().max(60).optional().nullable(),
  structure: z
    .array(z.object({ chapterTitle: z.string().max(200), sceneCount: z.number().int().min(1).max(80), summary: z.string().max(600) }))
    .min(1)
    .max(60),
  narrationTone: z.string().max(200),
  visualStyle: z.string().max(300),
  musicMood: z.string().max(120),
  needsVoiceRecording: z.boolean(),
  captions: z.boolean(),
  rationale: z.string().max(1200),
});

const DIRECTOR_SYSTEM_PROMPT = `Tu es le DIRECTEUR DE PRODUCTION de Gen3ia Video Agent, un studio vidéo IA.
Tu transformes une demande libre en plan de production professionnel.
Tu réponds STRICTEMENT en JSON (aucun texte hors JSON) selon ce schéma :
{
  "title": string, "description": string, "language": "fr"|"en"|..., 
  "aspectRatio": "16:9"|"9:16"|"1:1"|"4:5"|"21:9",
  "resolution": "480p"|"720p"|"1080p"|"1440p"|"4K",
  "fps": 24|25|30|60,
  "targetDurationSec": nombre,
  "style": string, "audience": string|null, "platform": string|null,
  "structure": [{"chapterTitle": string, "sceneCount": nombre, "summary": string}],
  "narrationTone": string, "visualStyle": string, "musicMood": string,
  "needsVoiceRecording": boolean, "captions": boolean, "rationale": string
}
Règles :
- La durée totale et le nombre de scènes doivent être cohérents (une scène dure 5 à 12 s).
- Un documentaire YouTube de long format a 5 à 8 chapitres ; un Short a 1 chapitre.
- "captions" vaut true si la plateforme est TikTok/Shorts/Reels ou si la demande le suggère.
- "needsVoiceRecording" vaut true seulement si l'utilisateur dit utiliser SA voix.
- L'estimation de durée (targetDurationSec) doit respecter la demande explicite de l'utilisateur.`;

export interface DirectorResult {
  plan: ProductionPlan;
  applied: boolean;
}

export async function buildProductionPlan(brief: string, project: VideoProject): Promise<ProductionPlan> {
  const userPrompt = [
    `Demande de l'utilisateur : ${brief}`,
    `Contexte du projet existant : titre « ${project.title} », durée cible ${project.targetDurationSec}s, format ${project.aspectRatio} ${project.resolution}, langue ${project.language}, style ${project.style}, plateforme ${project.platform ?? "non précisée"}.`,
    "Produis le plan de production JSON.",
  ].join("\n");

  const response = await generate({
    task: "reasoning",
    messages: [
      { role: "system", content: DIRECTOR_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.4,
    maxTokens: 2200,
    requiresStructuredOutput: true,
  });

  const raw = extractJsonObject(response.text);
  const parsed = PLAN_SCHEMA.safeParse(raw);
  if (parsed.success) {
    const data = parsed.data;
    return normalizePlan({
      ...data,
      audience: data.audience ?? undefined,
      platform: data.platform ?? undefined,
    });
  }
  // Repli déterministe : un plan cohérent construit depuis le projet —
  // la production ne bloque jamais sur un refus de format du modèle.
  return fallbackPlan(brief, project);
}

function normalizePlan(plan: ProductionPlan): ProductionPlan {
  const cloned: ProductionPlan = { ...plan, audience: plan.audience ?? undefined, platform: plan.platform ?? undefined };
  assertDurationAllowed(cloned.targetDurationSec);
  assertResolutionAllowed(cloned.resolution);
  cloned.structure = cloned.structure.slice(0, 60);
  return cloned;
}

export function fallbackPlan(brief: string, project: VideoProject): ProductionPlan {
  const lower = brief.toLowerCase();
  const isShort = /\b(short|tiktok|reels|60 secondes|1 minute)\b/.test(lower);
  const durationSec = project.targetDurationSec;
  const sceneCount = Math.max(3, Math.min(60, Math.round(durationSec / 9)));
  const chapters = Math.max(1, Math.min(8, Math.round(sceneCount / 5)));
  return {
    title: project.title,
    description: brief.slice(0, 400),
    language: project.language,
    aspectRatio: project.aspectRatio,
    resolution: project.resolution,
    fps: project.fps,
    targetDurationSec: durationSec,
    style: project.style,
    audience: project.audience,
    platform: project.platform,
    structure: Array.from({ length: chapters }, (_, i) => ({
      chapterTitle: i === 0 ? "Introduction" : `Partie ${i + 1}`,
      sceneCount: Math.ceil(sceneCount / chapters),
      summary: "Chapitre planifié en mode de repli (réponse du directeur indisponible).",
    })),
    narrationTone: "documentaire, posé et factuel",
    visualStyle: project.style,
    musicMood: isShort ? "énergique" : "cinématographique discret",
    needsVoiceRecording: /ma voix|my voice/i.test(brief),
    captions: isShort || project.aspectRatio === "9:16",
    rationale: "Plan de repli déterministe : durée et structure dérivées du projet.",
  };
}

/** Applique le plan au projet (snapshot avant application → réversible). */
export async function applyProductionPlan(
  userId: string,
  projectId: string,
  brief: string,
): Promise<DirectorResult> {
  const { getOwnedProjectOrThrow } = await import("@/lib/video/project-service");
  const project = await getOwnedProjectOrThrow(userId, projectId);
  const plan = await buildProductionPlan(brief, project);

  await snapshotVersion(userId, projectId, "Avant plan du directeur", "agent", brief.slice(0, 120));
  await patchProject(userId, projectId, {
    title: plan.title,
    description: plan.description,
    language: plan.language,
    aspectRatio: plan.aspectRatio,
    resolution: plan.resolution,
    fps: plan.fps,
    targetDurationSec: plan.targetDurationSec,
    style: plan.style,
    audience: plan.audience,
    platform: plan.platform,
    musicMood: plan.musicMood,
    status: "planning",
  });
  await appendProductionLog(userId, projectId, {
    actor: "director",
    message: `Plan de production appliqué : ${plan.structure.length} chapitre(s), ${plan.structure.reduce((n, c) => n + c.sceneCount, 0)} scènes prévues, ${Math.round(plan.targetDurationSec / 60)} min. ${plan.rationale}`,
  });
  return { plan, applied: true };
}
