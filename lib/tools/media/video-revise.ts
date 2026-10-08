import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";

/**
 * Outil video.revise — PILOTAGE et RÉVISION d'une vidéo depuis le chat
 * (Task 106-a).
 *
 * Avant cet outil, toute la machinerie de révision conversationnelle
 * (lib/video/revision-service : rythme, musique, voix, sous-titres, scène,
 * versions) et les commandes de rendu (pause/reprise/annulation, exports
 * dérivés) existaient côté serveur mais étaient INACCESSIBLES au chat —
 * l'agent pouvait lancer une production sans pouvoir ni la suivre ni
 * l'ajuster. Cet outil est la passerelle unique :
 *
 *  - action "revise"       → applyRevision (intentions LLM + déterministes,
 *                            version snapshot + journal production) ;
 *  - action "pause_render" / "resume_render" / "cancel_render"
 *                          → commandes de la file de rendu (sourceJobId
 *                            résolu sur le DERNIER rendu du projet) ;
 *  - action "add_exports"  → formats dérivés supplémentaires (TikTok,
 *                            Shorts, Reels, 1:1…) sur le master terminé.
 *
 * Risque "high" : écrit le projet (versions), interrompt éventuellement un
 * rendu en cours — la carte de validation humaine s'applique via la
 * politique de permission. Tous les messages sont FR et actionnables.
 */

const ACTIONS = ["revise", "pause_render", "resume_render", "cancel_render", "add_exports"] as const;

const VideoReviseInput = z.object({
  /** Projet vidéo concerné. */
  projectId: z.string().min(1).max(120),
  /** Action demandée (défaut : "revise"). */
  action: z.enum(ACTIONS).optional(),
  /**
   * Instruction de révision EN LANGAGE NATUREL (action "revise") — ex.
   * « va plus vite », « mets une musique énergique », « utilise ma voix »,
   * « supprime la scène 3 », « style de sous-titres cinéma ».
   */
  instruction: z.string().min(3).max(500).optional(),
  /** Identifiant du job de rendu (actions render ; défaut : dernier rendu du projet). */
  sourceJobId: z.string().min(1).max(120).optional(),
  /** Formats dérivés à produire (action "add_exports", max 4). */
  targets: z
    .array(z.enum(["master_16_9", "youtube_16_9", "shorts_9_16", "tiktok_9_16", "reels_9_16", "square_1_1", "facebook_16_9"]))
    .max(4)
    .optional(),
});

export interface VideoReviseToolOutput {
  action: (typeof ACTIONS)[number];
  applied: boolean;
  message: string;
  projectId: string;
  /** Détails normalisés selon l'action (intention appliquée, exports…). */
  details?: Record<string, unknown>;
}

export const videoReviseTool: ToolDefinition<
  z.infer<typeof VideoReviseInput>,
  VideoReviseToolOutput
> = {
  id: "video.revise",
  name: "Video Revision & Control",
  description:
    "Revise or control an EXISTING video project from natural language: change pacing/music/voice/subtitle style, delete or regenerate scenes, pause/resume/cancel the render, or add derived export formats (TikTok, Shorts, Reels). Requires projectId.",
  category: "media",
  risk: "high",
  inputSchema: VideoReviseInput,
  async execute(input, context): Promise<VideoReviseToolOutput> {
    const action = input.action ?? "revise";
    const base: VideoReviseToolOutput = { action, applied: false, projectId: input.projectId, message: "" };

    // ── Révision conversationnelle (intentions riches, version snapshot) ──
    if (action === "revise") {
      if (!input.instruction?.trim()) {
        base.message = "Donnez une instruction de révision en langage naturel (ex. « mets une musique énergique »).";
        return base;
      }
      const { applyRevision } = await import("@/lib/video/revision-service");
      const result = await applyRevision({
        userId: context.userId,
        projectId: input.projectId,
        instruction: input.instruction.trim(),
        // Origine canonique résolue côté serveur (champ déprécié/ignoré).
        origin: "",
      });
      base.applied = result.applied;
      base.message = result.message;
      base.details = { intent: result.intent, changed: result.changed };
      return base;
    }

    // ── Commandes de la file de rendu (dernier rendu du projet par défaut) ──
    if (action === "pause_render" || action === "resume_render" || action === "cancel_render") {
      const renderQueue = await import("@/lib/video/render-queue");
      const jobId = await resolveRenderJobId(context.userId, input.projectId, input.sourceJobId);
      if (!jobId) {
        base.message = "Aucun rendu trouvé pour ce projet — lancez d'abord un rendu (ou terminez la production).";
        return base;
      }
      if (action === "pause_render") {
        await renderQueue.pauseJob(context.userId, jobId);
        base.applied = true;
        base.message = "Rendu mis en pause — reprenez-le quand vous voulez (reprise au même stade, aucun travail perdu).";
      } else if (action === "resume_render") {
        await renderQueue.resumeJob(context.userId, jobId);
        base.applied = true;
        base.message = "Reprise du rendu demandée — le job se relance depuis ses checkpoints.";
      } else {
        await renderQueue.cancelJob(context.userId, jobId);
        base.applied = true;
        base.message = "Rendu annulé — les crédits non consommés sont restitués.";
      }
      base.details = { renderJobId: jobId };
      return base;
    }

    // ── Formats dérivés supplémentaires sur le master terminé ──
    if (action === "add_exports") {
      const exportService = await import("@/lib/video/export-service");
      const targets = input.targets?.length
        ? input.targets
        : (["shorts_9_16", "tiktok_9_16", "reels_9_16"] as const).slice();
      const sourceJobId = await resolveRenderJobId(context.userId, input.projectId, input.sourceJobId, "completed");
      if (!sourceJobId) {
        base.message = "Aucun master terminé pour ce projet — attendez la fin du rendu avant de demander des formats dérivés.";
        return base;
      }
      const result = await exportService.startAdditionalExports({
        userId: context.userId,
        projectId: input.projectId,
        sourceJobId,
        targets,
      });
      base.applied = true;
      base.message = `Exports lancés : ${result.targets.join(", ") || "aucun nouveau format (déjà exportés)"} — ils seront disponibles dans l'atelier vidéo.`;
      base.details = { sourceJobId, exportJobId: result.jobId, queued: result.queued, requested: result.targets };
      return base;
    }

    base.message = "Action inconnue.";
    return base;
  },
};

/**
 * Résout l'identifiant du job de rendu : explicite (avec vérification de
 * propriété via getOwnedJobOrThrow) sinon le DERNIER rendu du projet
 * (optionnellement filtré au statut "completed" pour les exports).
 */
async function resolveRenderJobId(
  userId: string,
  projectId: string,
  explicitJobId?: string,
  requireStatus?: "completed",
): Promise<string | null> {
  const { getOwnedJobOrThrow, listJobs } = await import("@/lib/video/render-queue");
  if (explicitJobId) {
    await getOwnedJobOrThrow(userId, explicitJobId); // lève si introuvable/non propriétaire
    return explicitJobId;
  }
  const jobs = await listJobs(userId, projectId);
  const eligible = requireStatus ? jobs.filter((j) => j.status === requireStatus) : jobs;
  return eligible[0]?.id ?? null;
}
