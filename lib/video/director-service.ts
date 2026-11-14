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
import { demandeSousTitres } from "@/lib/video/intention-media";
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
- "captions" vaut false PAR DÉFAUT : true UNIQUEMENT si l'utilisateur demande explicitement des sous-titres / légendes / texte à l'écran (détection déterministe demandeSousTitres appliquée sur le brief — jamais une initiative du modèle).
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

  // Tentative 1 : appel direct historique. extractJsonObject PEUT lever
  // (« Planner returned invalid JSON » — constat production sonde vidéo
  // 2026-11-12 : job failed stage=plan) : l'échec est RATTRAPÉ ci-dessous
  // au lieu de faire échouer toute la production.
  try {
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
  } catch {
    // JSON irréparable ou appel échoué : relance STRUCTURÉE ci-dessous.
  }

  // Relance STRUCTURÉE (motif « repli structuré » du documentaire 7c6e432,
  // étendu au plan vidéo) : le fournisseur est CONTRAINT au JSON validé par
  // PLAN_SCHEMA avec UNE relance corrective injectant l'écart observé —
  // facturée au wallet du propriétaire (même voie que les agents).
  try {
    const { generateStructuredForUser } = await import("@/lib/tools/agent-suite/llm-json");
    const plan = await generateStructuredForUser({
      userId: project.userId,
      executionId: `director_plan_${project.id}`,
      task: "reasoning",
      system: DIRECTOR_SYSTEM_PROMPT,
      user: userPrompt,
      schema: PLAN_SCHEMA,
      maxTokens: 2200,
      maxAttempts: 2,
    });
    await appendProductionLog(project.userId, project.id, {
      actor: "director",
      message: "Plan accepté après relance structurée (première réponse hors JSON).",
    });
    return normalizePlan({
      ...plan,
      audience: plan.audience ?? undefined,
      platform: plan.platform ?? undefined,
    });
  } catch {
    // Repli déterministe : un plan cohérent construit depuis le projet —
    // la production ne bloque JAMAIS sur un refus de format du modèle.
    await appendProductionLog(project.userId, project.id, {
      actor: "director",
      message: "Relance structurée échouée : plan de repli déterministe appliqué.",
    }).catch(() => undefined);
    return fallbackPlan(brief, project);
  }
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
  // Demande propriétaire 2026-11-14 — SOUS-TITRES SUR DEMANDE EXPLICITE
  // SEULEMENT (source unique demandeSousTitres) : ni la narration ni le
  // format vertical ne les activent plus. Un refus explicite reste un
  // refus (la fonction honore « sans sous-titres »).
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
    // Volontaire utilisateur = contrat : sous-titres UNIQUEMENT si demandés.
    captions: demandeSousTitres(brief),
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
