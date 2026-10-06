import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";
import type { ProductionStage } from "@/lib/video/production-queue";

/**
 * Outil video.create — production vidéo complète RÉELLE (audit outils
 * médias).
 *
 * Déclenche la chaîne de production autonome Gen3ia (projet persisté :
 * scénario → storyboard → assets → voix → montage → QC → rendu → export)
 * via la file de production réelle lib/video/production-queue.ts (Task 1-a)
 * — le MÊME chemin que POST /api/video/projects/plan (validation
 * VideoProjectCreateSchema + createProject + premier tick QStash).
 *
 * Import paresseux VOLONTAIRE (runtime) : le module de production tire toute
 * la machinerie vidéo (Firestore, engines, bridges) ; l'outil ne doit le
 * charger QUE lorsqu'il est réellement exécuté — l'enregistrement du
 * registre reste instantané et sans effet de bord. Si le module est
 * indisponible (build sans pipeline vidéo), l'erreur est claire et FRANÇAISE
 * — jamais un « Cannot find module » brut ni un repli silencieux.
 *
 * Risque high : action longue (minutes) et payante (appels Agnes en aval) →
 * carte de validation humaine via la politique de permission (checkPermission
 * : high ⇒ requiresApproval par défaut).
 */

/**
 * Ratios d'aspect supportés par le pipeline vidéo Gen3ia — SOURCE UNIQUE.
 *
 * Convention (audit médias 103-c) : ces 3 valeurs étaient dupliquées entre ce
 * zod et la validation inline de l'intercept « video.create » du chat
 * (lib/domain/conversations/engine.ts). Alignement (audit 103-f) : l'intercept
 * du chat IMPORTE désormais CE constant (plus aucun littéral dupliqué) —
 * toute évolution des ratios part d'ici et se propage au tool et au chat.
 */
export const VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;

/** Ratio d'aspect vidéo valide (union des valeurs du constant partagé). */
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];

const CreateVideoInput = z.object({
  /** Brief créatif complet : sujet, ton, durée visée, public, style. */
  prompt: z.string().min(10).max(4000),
  /** Titre du projet vidéo (défaut : déduit du prompt par le pipeline). */
  title: z.string().max(120).optional(),
  /** Cadrage du master (valeurs : VIDEO_ASPECT_RATIOS, source unique). */
  aspectRatio: z.enum(VIDEO_ASPECT_RATIOS).optional(),
  /** Générer la narration vocale (voix IA). Défaut pipeline : tentative avec voix. */
  voiceEnabled: z.boolean().optional(),
  /** Incruster les sous-titres. */
  subtitlesEnabled: z.boolean().optional(),
});

export interface CreateVideoToolOutput {
  jobId: string;
  projectId: string;
  status: "queued";
  stage: ProductionStage;
  /** Mode de continuation effectif du job (QStash si configuré, sinon sondage). */
  queueMode: "qstash" | "poll";
}

export const createVideoTool: ToolDefinition<
  z.infer<typeof CreateVideoInput>,
  CreateVideoToolOutput
> = {
  id: "video.create",
  name: "Video Production",
  description:
    "Start a fully autonomous REAL video production (script, storyboard, visuals, voice-over, editing, render) and track its progress via the returned jobId/projectId.",
  category: "media",
  risk: "high",
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
    const job = await productionQueue.createVideoProductionJob({
      userId: context.userId,
      prompt: input.prompt.trim(),
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      options: {
        ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
        ...(input.voiceEnabled !== undefined ? { voiceEnabled: input.voiceEnabled } : {}),
        ...(input.subtitlesEnabled !== undefined
          ? { subtitlesEnabled: input.subtitlesEnabled }
          : {}),
      },
    });
    return {
      jobId: job.jobId,
      projectId: job.projectId,
      status: job.status,
      stage: job.stage,
      queueMode: job.queueMode,
    };
  },
};
