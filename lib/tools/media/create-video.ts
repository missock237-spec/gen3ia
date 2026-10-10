import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";
import type { ProductionStage } from "@/lib/video/production-queue";
import { VIDEO_ASPECT_RATIOS as PIPELINE_ASPECT_RATIOS } from "@/lib/video/types";

/**
 * Outil video.create — production vidéo complète RÉELLE (audit outils
 * médias, Task 106-a : paramètres de production pilotables depuis le chat).
 *
 * Déclenche la chaîne de production autonome Gen3ia (projet persisté :
 * scénario → storyboard → assets → voix → montage → QC → rendu → export)
 * via la file de production réelle lib/video/production-queue.ts (Task 1-a)
 * — le MÊME chemin que POST /api/video/projects/plan (validation
 * VideoProjectCreateSchema + createProject + premier tick QStash).
 *
 * Task 106-a — SURFACE COMPLÈTE : le pipeline (ProductionJobOptions)
 * acceptait déjà durée, résolution, langue, style, audience, plateforme,
 * formats dérivés — seul le relais manquait. L'outil les expose désormais
 * TOUS (le LLM du chat les renseigne depuis la demande de l'utilisateur),
 * le constant des ratios est ALIGNÉ sur lib/video/types.ts (5 valeurs —
 * source unique du pipeline) et la réponse porte l'URL de l'atelier.
 *
 * Import paresseux VOLONTAIRE (runtime) : le module de production tire toute
 * la machinerie vidéo (Firestore, engines, bridges) ; l'outil ne doit le
 * charger QUE lorsqu'il est réellement exécuté — l'enregistrement du
 * registre reste instantané et sans effet de bord. Si le module est
 * indisponible (build sans pipeline vidéo), l'erreur est claire et FRANÇAISE
 * — jamais un « Cannot find module » brut ni un repli silencieux.
 *
 * Risque medium (audit 10-10) : outil INTERNE — l'enchère part sur la file
 * de production Gen3ia et le frais de résultat est réglé par l'escrow du
 * portefeuille (RCP) ; aucune app externe ni secret utilisateur n'est
 * manipulé par l'outil lui-même → AUCUNE carte de validation
 * (directive « aucune approbation pour un outil interne », captures 07:24 :
 * video.create bloqué par « Confirmation requise »).
 */

/**
 * Ratios d'aspect supportés par le pipeline vidéo Gen3ia — SOURCE UNIQUE.
 *
 * Task 106-a : RÉ-EXPORT du constant canonique de lib/video/types.ts (5
 * valeurs : 16:9, 9:16, 1:1, 4:5, 21:9) — le tool, l'intercept du chat
 * (lib/domain/conversations/engine.ts) et le pipeline partagent DÉSORMAIS
 * la même définition — Alignement total (l'ancien constant local à 3
 * valeurs était un désalignement tool/pipeline).
 */
export const VIDEO_ASPECT_RATIOS = PIPELINE_ASPECT_RATIOS;

/** Ratio d'aspect vidéo valide (union des valeurs du constant partagé). */
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];

const CreateVideoInput = z.object({
  /** Brief créatif complet : sujet, ton, durée visée, public, style. */
  prompt: z.string().min(10).max(4000),
  /** Titre du projet vidéo (défaut : déduit du prompt par le pipeline). */
  title: z.string().max(120).optional(),
  /** Cadrage du master (valeurs : VIDEO_ASPECT_RATIOS — 16:9, 9:16, 1:1, 4:5, 21:9). */
  aspectRatio: z.enum(VIDEO_ASPECT_RATIOS).optional(),
  /** Résolution du master (480p, 720p, 1080p, 1440p, 4K). Défaut pipeline : 1080p. */
  resolution: z.enum(["480p", "720p", "1080p", "1440p", "4K"]).optional(),
  /** Durée cible en secondes (10..3600 — plafond VIDEO_LIMITS). */
  targetDurationSec: z.number().int().min(10).max(3600).optional(),
  /** Langue de la narration (code ou nom, ex : "fr", "français"). */
  language: z.string().max(30).optional(),
  /** Style visuel/narratif (ex : "documentaire", "dynamique", "cinématique"). */
  style: z.string().max(120).optional(),
  /** Public cible (ex : "entrepreneurs", "adolescents"). */
  audience: z.string().max(160).optional(),
  /** Plateforme de diffusion visée (ex : "TikTok", "YouTube"). */
  platform: z.string().max(60).optional(),
  /** Ambiance musicale (cinematographique, documentaire, tension, energique, emotionnel, neutre). */
  musicMood: z.string().max(40).optional(),
  /** Générer la narration vocale (voix IA). Défaut pipeline : tentative avec voix. */
  voiceEnabled: z.boolean().optional(),
  /** Incruster les sous-titres. */
  subtitlesEnabled: z.boolean().optional(),
  /**
   * Formats dérivés à produire après le master (max 4 — ex : shorts_9_16,
   * tiktok_9_16). L'intercept du chat les déduit de la plateforme demandée.
   */
  derivedTargets: z
    .array(z.enum(["master_16_9", "youtube_16_9", "shorts_9_16", "tiktok_9_16", "reels_9_16", "square_1_1", "facebook_16_9"]))
    .max(4)
    .optional(),
});

export interface CreateVideoToolOutput {
  jobId: string;
  projectId: string;
  status: "queued";
  stage: ProductionStage;
  /** Mode de continuation effectif du job (QStash si configuré, sinon sondage). */
  queueMode: "qstash" | "poll";
  /** Atelier vidéo du projet (timeline, versions, exports, révisions). */
  studioUrl: string;
  /** Paramètres de production réellement retenus (traçabilité chat). */
  appliedOptions: Record<string, unknown>;
}

/** Clés d'options reconnues pour la production (filtre de relais tool→job). */
const OPTION_KEYS = [
  "aspectRatio",
  "resolution",
  "targetDurationSec",
  "language",
  "style",
  "audience",
  "platform",
  "musicMood",
  "voiceEnabled",
  "subtitlesEnabled",
  "derivedTargets",
] as const;

/**
 * Filtre un objet d'options ARBITRAIRE (sortie du planificateur LLM) vers
 * ProductionJobOptions validées — les clés inconnues et les valeurs vides
 * sont écartées. Utilisé par l'outil ET par l'intercept du chat (source
 * unique du relais, zéro divergence).
 */
export function sanitizeProductionOptions(raw: unknown): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object") return options;
  const record = raw as Record<string, unknown>;
  for (const key of OPTION_KEYS) {
    const value = record[key];
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length > 0) options[key] = value;
      continue;
    }
    if (typeof value === "object") continue;
    options[key] = value;
  }
  return options;
}

export const createVideoTool: ToolDefinition<
  z.infer<typeof CreateVideoInput>,
  CreateVideoToolOutput
> = {
  id: "video.create",
  name: "Video Production",
  description:
    "Start a fully autonomous REAL video production (script, storyboard, visuals, voice-over, editing, render) with full creative control (duration, resolution, aspect ratio, language, style, audience, platform, music mood, derived formats) and track its progress via the returned jobId/projectId.",
  category: "media",
  risk: "medium",
  inputSchema: CreateVideoInput,
  async execute(input, context): Promise<CreateVideoToolOutput> {
    let productionQueue: typeof import("@/lib/video/production-queue");
    try {
      productionQueue = await import("@/lib/video/production-queue");
    } catch (importError) {
      throw new Error(
        `La production vidéo n'est pas disponible sur cette plateforme (file de production introuvable) : ${
          importError instanceof Error ? importError.message : String(importError)
        }`,
      );
    }
    const appliedOptions = sanitizeProductionOptions(input);
    // Task 107-a — conversation d'origine : lue dans le CONTEXTE d'exécution
    // (metadata remplie par l'appelant) — JAMAIS un champ d'entrée du schéma
    // (l'LLM ne doit pas pouvoir l'inventer). Portée par le job pour la
    // livraison du résultat dans le chat à la complétion.
    const conversationId = context.metadata?.conversationId?.trim();
    const job = await productionQueue.createVideoProductionJob({
      userId: context.userId,
      prompt: input.prompt.trim(),
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(conversationId ? { conversationId } : {}),
      options: appliedOptions as Parameters<typeof productionQueue.createVideoProductionJob>[0]["options"],
    });
    return {
      jobId: job.jobId,
      projectId: job.projectId,
      status: job.status,
      stage: job.stage,
      queueMode: job.queueMode,
      studioUrl: `/studio/video/${job.projectId}`,
      appliedOptions,
    };
  },
};
