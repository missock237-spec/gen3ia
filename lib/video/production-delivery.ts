import "server-only";

/**
 * GEN3IA VIDEO AGENT — LIVRAISON CHAT des productions vidéo (module 20,
 * partie 2 — Task 107-a, extrait de production-queue.ts).
 *
 * À la complétion d'un job de production, le résultat « monte » dans la
 * conversation d'origine (message FR + artefact vidéo) même si la page est
 * fermée. Mêmes primitives que le lancement (appendMessage/createArtifact
 * via imports DYNAMIQUES — anti-cycle : la couche conversation importe la
 * file, jamais l'inverse). Idempotence par marqueur chatDeliveredAt.
 */

import { logger } from "@/lib/observability/logger";
import { logSystem } from "@/lib/video/project-service";
import { writeCheckpointSet } from "@/lib/db/firestore-resilient";
// Task 107-a — createVideoPlaybackUrl : MÊME source que la carte client
// (video-production-card → GET .../render → output.r2Key présigné) pour la
// livraison du master dans le chat à la complétion.
import { createVideoPlaybackUrl } from "@/lib/video/storage";
import { getJob } from "@/lib/video/render-queue";
import { PRODUCTION_JOBS_COLLECTION, type ProductionJobStatus, type ProductionStage, type VideoProductionJob } from "@/lib/video/production-job";
import { nowIso } from "@/lib/video/queue-core";

/** Étiquettes FR des étapes pour les messages de livraison (ton video-status). */
const DELIVERY_STAGE_LABELS: Record<ProductionStage, string> = {
  project: "création du projet",
  plan: "plan du réalisateur",
  script: "écriture du scénario",
  assets: "génération des visuels",
  voice: "narration vocale",
  render: "montage et rendu",
  done: "finalisation",
};

export interface VideoDeliveryMessageParams {
  /** Statut TERMINAL du job (completed / failed / cancelled). */
  status: ProductionJobStatus;
  title: string;
  projectId: string;
  /** Étape atteinte (précision du message d'échec). */
  stage: ProductionStage;
  /** Message d'erreur stocké (échec définitif) — tronqué à 200 caractères. */
  error?: string;
  /** Journal d'avertissements FR (tolérance par scène) — 3 lignes max. */
  warnings?: string[];
  /** URL de lecture présignée du master (complétion seulement, sinon absent). */
  masterUrl?: string;
}

/**
 * Message FR de livraison (PUR, testé) — même ton que le message de
 * lancement du tour vidéo (runVideoTurn) : titre, avertissements éventuels
 * (3 max), lien de lecture du master, atelier, relance via video.revise.
 */
export function buildVideoDeliveryMessage(params: VideoDeliveryMessageParams): string {
  const lines: string[] = [];
  if (params.status === "completed") {
    lines.push("Votre vidéo est prête 🎬", "");
    lines.push(`Titre : « ${params.title || "Vidéo Gen3ia"} »`);
    const warnings = (params.warnings ?? []).slice(0, 3).map((w) => w.trim().slice(0, 200)).filter(Boolean);
    if (warnings.length > 0) {
      lines.push("Points d'attention pendant la production :");
      for (const warning of warnings) lines.push(`- ${warning}`);
    }
    lines.push(params.masterUrl ? `Regardez votre vidéo ici : ${params.masterUrl}` : "La lecture est disponible dans la carte vidéo ci-dessous.");
    lines.push(`Le projet complet (timeline, versions, exports) est disponible dans l'atelier vidéo : /studio/video/${params.projectId}`);
    lines.push("Demandez-moi des modifications (musique, rythme, visuels…) : je relance une passe de révision (video.revise) sur ce projet.");
    return lines.join("\n");
  }
  if (params.status === "failed") {
    lines.push("Votre production vidéo n'a pas abouti.", "");
    const label = DELIVERY_STAGE_LABELS[params.stage] ?? params.stage;
    const error = params.error?.trim().slice(0, 200);
    lines.push(`Étape : ${label}${error ? ` — ${error}` : "."}`);
    lines.push(`Les étapes déjà produites restent consultables dans l'atelier vidéo : /studio/video/${params.projectId}`);
    lines.push("Demandez-moi une relance ou des ajustements (video.revise) : la production repart du dernier point sauvegardé.");
    return lines.join("\n");
  }
  lines.push("Votre production vidéo a bien été annulée.", "");
  lines.push(`Le projet reste accessible dans l'atelier vidéo : /studio/video/${params.projectId} — vous pouvez relancer la production à tout moment.`);
  return lines.join("\n");
}

/**
 * Livre le résultat d'un job TERMINAL dans sa conversation d'origine :
 * message assistant (contenu FR selon le statut) + artefact vidéo de
 * livraison. NE LÈVE JAMAIS — un incident de livraison est journalisé.
 *
 * Task 113 — ORDRE « LIVRER D'ABORD, MARQUER ENSUITE » : l'ancien ordre
 * (marqueur posé AVANT le message, effacé en cas d'échec) perdait
 * définitivement le message quand l'ÉCRITURE du marqueur AVAIT réussi mais
 * l'effacement échouait (panne du magasin au même instant) — le job restait
 * « livré » sans message et le filet de reprise sortait immédiatement.
 * Désormais :
 *   1. anti-doublon par LECTURE (les derniers messages de la conversation :
 *      un message assistant de livraison pour ce projet prouve la livraison
 *      — le contenu est déterministe sauf l'URL présignée) → re-pose le
 *      marqueur au mieux et sort : jamais de doublon après un incident
 *      « message écrit, marqueur pas écrit » ;
 *   2. appendMessage (LE livrable) — en cas d'échec, AUCUN marqueur posé :
 *     le prochain passage re-livre naturellement ;
 *   3. artefact de livraison (si aucun artefact de lancement/vidéo) ;
 *   4. marqueur chatDeliveredAt (best-effort) — son échec est compensé par
 *      l'anti-doublon 1 (cosmétique : au pire un message en double, JAMAIS
 *      un message perdu).
 */
export async function deliverJobToConversation(job: VideoProductionJob): Promise<void> {
  // Conditions de livraison : conversation connue, pas déjà livré (garde
  // primaire rapide sur le marqueur), statut terminal. Un job hors chat
  // (studio/API) n'a RIEN à livrer.
  if (!job.conversationId || job.chatDeliveredAt) return;
  if (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled") return;

  try {
    // Imports DYNAMIQUES (anti-cycle) : mêmes primitives que le lancement.
    const { appendMessage, listMessages: listRecent } = await import("@/lib/chat/repository");
    const { createArtifact, listArtifacts } = await import("@/lib/domain/artifacts/repository");

    // 1) ANTI-DOUBLON par lecture du fil : le message de livraison contient
    // toujours le lien studio du projet + une phrase-marker déterministe
    // (l'URL présignée varie, le reste non). Les 40 derniers messages
    // suffisent largement (la livraison suit de près la fin du tour).
    const recent = await listRecent(job.userId, job.conversationId, 40, { order: "recent" }).catch(() => []);
    const studioLink = `studio/video/${job.projectId}`;
    const phrase =
      job.status === "completed"
        ? "Votre vidéo est prête"
        : job.status === "failed"
          ? "Votre production vidéo n'a pas abouti"
          : "a bien été annulée";
    const alreadyDelivered = recent.some(
      (m) => m.role === "assistant" && m.content.includes(phrase) && m.content.includes(studioLink),
    );
    if (alreadyDelivered) {
      // Déjà livré (le marqueur était absent — échec d'écriture antérieur) :
      // re-pose le marqueur au mieux et sort — jamais de doublon.
      await writeCheckpointSet(
        PRODUCTION_JOBS_COLLECTION,
        job.id,
        { chatDeliveredAt: nowIso(), updatedAt: nowIso() },
        job.userId,
      ).catch(() => undefined);
      return;
    }

    // URL de lecture du master : MÊME source que la carte client
    // (video-production-card → GET .../render → output.r2Key présigné) —
    // ici en direct : job de rendu rattaché (job.renderJobId) → clé R2 du
    // master → URL présignée 900 s. L'URL est un PLUS : un incident de
    // signature n'empêche jamais la livraison du message.
    let masterUrl: string | undefined;
    if (job.status === "completed" && job.renderJobId) {
      try {
        const renderJob = await getJob(job.renderJobId);
        const r2Key = renderJob?.output?.r2Key;
        if (r2Key) masterUrl = await createVideoPlaybackUrl(job.userId, r2Key, 900).catch(() => undefined);
      } catch {
        // Rendu introuvable / R2 indisponible : message livré sans URL.
      }
    }

    const content = buildVideoDeliveryMessage({
      status: job.status,
      title: job.title,
      projectId: job.projectId,
      stage: job.stage,
      ...(job.status === "failed" && job.error ? { error: job.error } : {}),
      ...(job.status === "completed" && job.warnings?.length ? { warnings: job.warnings } : {}),
      ...(masterUrl ? { masterUrl } : {}),
    });

    // 2) LE LIVRABLE : le message part AVANT tout marquage. Un échec ici ne
    // laisse AUCUN marqueur → reprise garantie au prochain passage.
    await appendMessage({
      conversationId: job.conversationId,
      userId: job.userId,
      role: "assistant",
      content,
      generationStatus: "complete",
    });

    // 3) Artefact de livraison (carte vidéo du chat) : AUCUN mécanisme de mise
    // à jour d'artefact dans le dépôt (seulement addArtifactVersion) → on
    // crée UNIQUEMENT si l'artefact de lancement n'existe pas déjà (même
    // videoJobId ou videoProjectId) — la carte client se met à jour par
    // SSE/poll, jamais par le nombre d'artefacts. Listing impossible → on
    // s'abstient (jamais de doublon au hasard ; le message est le livrable).
    const existing = await listArtifacts(job.userId, { conversationId: job.conversationId, type: "video", limit: 200 }).catch(() => null);
    if (existing && !existing.some((a) => a.videoJobId === job.id || a.videoProjectId === job.projectId)) {
      await createArtifact({
        userId: job.userId,
        conversationId: job.conversationId,
        type: "video",
        title: job.title || "Vidéo Gen3ia",
        note: job.status === "completed" ? "Vidéo terminée" : job.status === "failed" ? "Production vidéo échouée" : "Production vidéo annulée",
        videoProjectId: job.projectId,
        videoJobId: job.id,
      });
    }

    // 4) Marqueur d'idempotence (best-effort) : accélère les passages suivants.
    // Son échec n'est PAS une perte : l'anti-doublon 1 couvre la reprise.
    await writeCheckpointSet(
      PRODUCTION_JOBS_COLLECTION,
      job.id,
      { chatDeliveredAt: nowIso(), updatedAt: nowIso() },
      job.userId,
    ).catch(() => undefined);
  } catch (deliveryError) {
    // Incident de livraison journalisé — le tick n'échoue JAMAIS à cause de
    // la livraison : le prochain passage (tick tardif, sweep, GET) re-livre.
    const detail = deliveryError instanceof Error ? deliveryError.message : String(deliveryError);
    logger.warn(
      { jobId: job.id, conversationId: job.conversationId, error: detail },
      "video_delivery_failed",
    );
    await logSystem(job.projectId, `Livraison chat de la production ${job.id.slice(0, 8)} impossible (reprise automatique au prochain passage) : ${detail.slice(0, 200)}.`).catch(() => undefined);
  }
}
