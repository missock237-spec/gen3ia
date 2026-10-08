import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";

/**
 * Outil video.status — SUIVI de production vidéo depuis le chat (Task 106-a).
 *
 * Le chat pouvait LANCER une production (video.create) mais jamais la
 * SUIVRE : l'utilisateur devait ouvrir l'atelier. Cet outil interroge la
 * file de production réelle (lib/video/production-queue) et retourne
 * l'état consolidé : stage, progression pondérée, avertissements de scènes
 * (tolérance par scène Task 106-c), job de rendu associé et — quand le
 * master est prêt — une URL de lecture présignée (600 s).
 *
 * Lecture pure : aucun effet de bord, aucun coût, risque "low". L'accès
 * est STRICTEMENT restreint au propriétaire (userId) — un job d'un autre
 * utilisateur est « introuvable » (pas de fuite d'existence).
 */

const VideoStatusInput = z
  .object({
    /** Identifiant de job de production (retourné par video.create). */
    jobId: z.string().min(1).max(120).optional(),
    /** Identifiant de projet vidéo (sinon : DERNIÈRE production du propriétaire). */
    projectId: z.string().min(1).max(120).optional(),
  })
  .refine((input) => Boolean(input.jobId || input.projectId), {
    message: "Fournissez jobId ou projectId (au moins un).",
  });

export interface VideoStatusToolOutput {
  found: boolean;
  message: string;
  /** Détails normalisés (présents si found=true). */
  jobId?: string;
  projectId?: string;
  status?: string;
  stage?: string;
  /** Progression pondérée 0..1 (contrat UI ×100). */
  progress?: number;
  /** Position dans les scènes (assets/voix) — curseur de reprise. */
  sceneCursor?: number;
  /** Avertissements de production (scènes en échec toléré…). */
  warnings?: string[];
  renderJobId?: string;
  /** URL de lecture présignée du master (si le rendu est terminé). */
  playbackUrl?: string;
  studioUrl?: string;
  error?: string;
}

const STAGE_LABELS: Record<string, string> = {
  project: "Initialisation du projet",
  plan: "Plan du réalisateur",
  script: "Écriture du scénario",
  assets: "Génération des visuels",
  voice: "Narration vocale",
  render: "Montage et rendu",
  done: "Terminé",
};

export const videoStatusTool: ToolDefinition<
  z.infer<typeof VideoStatusInput>,
  VideoStatusToolOutput
> = {
  id: "video.status",
  name: "Video Status",
  description:
    "Track a REAL video production in real time: current stage (script, visuals, voice, render), weighted progress, scene warnings, and the playback URL of the finished master. Pass jobId from video.create, or projectId, or nothing to check the latest production.",
  category: "media",
  risk: "low",
  inputSchema: VideoStatusInput,
  async execute(input, context): Promise<VideoStatusToolOutput> {
    let productionQueue: typeof import("@/lib/video/production-queue");
    try {
      productionQueue = await import("@/lib/video/production-queue");
    } catch (importError) {
      throw new Error(
        `Le suivi de production vidéo n'est pas disponible sur cette plateforme : ${
          importError instanceof Error ? importError.message : String(importError)
        }`,
      );
    }

    // Résolution du job : explicite (jobId) → par projet → dernière production.
    const job = input.jobId
      ? await productionQueue.getProductionJob(input.jobId)
      : (await productionQueue.listProductionJobs(context.userId, input.projectId))[0] ?? null;

    if (!job || job.userId !== context.userId) {
      return {
        found: false,
        message: input.jobId
          ? "Aucune production vidéo trouvée pour cet identifiant (ou accès non autorisé)."
          : input.projectId
            ? "Aucune production vidéo trouvée pour ce projet."
            : "Vous n'avez aucune production vidéo en cours — lancez-en une avec la production vidéo.",
      };
    }

    const base: VideoStatusToolOutput = {
      found: true,
      jobId: job.id,
      projectId: job.projectId,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      ...(job.sceneCursor > 0 ? { sceneCursor: job.sceneCursor } : {}),
      ...(job.warnings?.length ? { warnings: job.warnings.slice(-8) } : {}),
      ...(job.renderJobId ? { renderJobId: job.renderJobId } : {}),
      ...(job.error ? { error: job.error } : {}),
      studioUrl: `/studio/video/${job.projectId}`,
      message: "",
    };

    const stageLabel = STAGE_LABELS[job.stage] ?? job.stage;
    const percent = Math.round(job.progress * 100);

    if (job.status === "failed") {
      base.message = `La production a échoué${job.error ? ` : ${job.error}` : "."} Vous pouvez la relancer depuis l'atelier vidéo.`;
      return base;
    }

    if (job.status === "completed" && job.stage === "done") {
      // Master prêt → URL de lecture présignée (échec silencieux : plus).
      base.playbackUrl = await resolveMasterPlaybackUrl(context.userId, job.projectId);
      base.message = `Production terminée (${percent} %). La vidéo est disponible dans l'atelier${base.playbackUrl ? " et lisible via l'URL ci-dessous" : ""}.`;
      return base;
    }

    const sceneInfo = job.sceneCursor > 0 ? ` — ${job.sceneCursor} scène(s) traitée(s)` : "";
    base.message = `Production en cours : ${stageLabel} (${percent} %)${sceneInfo}. La progression s'affiche en temps réel dans la conversation.`;
    return base;
  },
};

/**
 * URL de lecture du master (helper SÉPARÉE de execute pour rester testable
 * sans Firestore) : cherche le dernier rendu terminé du projet et signe
 * une URL présignée. Échecs silencieux (rendu absent, R2 indisponible) →
 * undefined — l'URL est un PLUS, jamais une condition de succès.
 */
export async function resolveMasterPlaybackUrl(
  userId: string,
  projectId: string,
): Promise<string | undefined> {
  try {
    const [{ listJobs }, { createVideoPlaybackUrl }] = await Promise.all([
      import("@/lib/video/render-queue"),
      import("@/lib/video/storage"),
    ]);
    const completed = (await listJobs(userId, projectId)).find(
      (j) => j.status === "completed" && j.output?.r2Key,
    );
    if (!completed?.output?.r2Key) return undefined;
    return await createVideoPlaybackUrl(userId, completed.output.r2Key);
  } catch {
    return undefined;
  }
}
