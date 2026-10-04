import "server-only";

/**
 * GEN3IA VIDEO AGENT — initialisation paresseuse de la timeline (Task 1-a FIX 2).
 *
 * SOURCE UNIQUE de la construction initiale : la route GET
 * /api/video/projects/[projectId]/timeline construisait la timeline à la
 * volée (lazy) — mais le WORKER de rendu (stagePlan) exigeait qu'elle
 * EXISTE déjà et échouait (« Timeline absente ») si l'utilisateur n'avait
 * jamais ouvert le panneau. Les deux chemins partagent désormais EXACTEMENT
 * la même logique, idempotente : timeline présente → aucun écrit ;
 * absente → construction depuis le scénario + piste VOIX synchronisée +
 * lit musical posé + persistance.
 */

import type { VideoProject, VideoTimeline } from "@/lib/video/types";
import { getOwnedProjectOrThrow, patchProject } from "@/lib/video/project-service";
import { buildTimelineFromScript, syncVoiceTrack, applyTimelinePatch } from "@/lib/video/timeline-service";
import { listAssets } from "@/lib/video/asset-service";
import { ensureMusicBed } from "@/lib/video/audio-engine";

export interface EnsuredTimeline {
  project: VideoProject;
  timeline: VideoTimeline;
  /** true si la timeline vient d'être construite (premier accès). */
  created: boolean;
}

/**
 * Garantit la timeline du projet (idempotent). Lève si le scénario est
 * absent — même message que la route GET (« Générez d'abord le scénario. »).
 */
export async function ensureProjectTimeline(userId: string, projectId: string): Promise<EnsuredTimeline> {
  let project = await getOwnedProjectOrThrow(userId, projectId);
  if (project.timeline) {
    return { project, timeline: project.timeline, created: false };
  }
  if (!project.script) throw new Error("Générez d'abord le scénario.");

  const shortForm = project.aspectRatio === "9:16";
  let timeline = buildTimelineFromScript(project, { shortForm, captionsStyle: shortForm ? "shorts_bold" : "documentary" });

  // Narrations disponibles → piste VOIX synchronisée + musique posée.
  const narrations = await listAssets(userId, projectId, "audio_narration");
  const byScene = new Map(narrations.filter((a) => a.sceneId).map((a) => [a.sceneId!, a]));
  timeline = syncVoiceTrack(
    timeline,
    project.script.scenes
      .filter((s) => byScene.has(s.id))
      .map((s) => ({
        sceneId: s.id,
        assetId: byScene.get(s.id)!.id,
        startSec: s.startSec,
        durationSec: Math.min(s.durationSec, byScene.get(s.id)!.media?.durationSec ?? s.durationSec),
      })),
  );

  const bed = await ensureMusicBed(userId, projectId, project.musicMood ?? "documentaire", timeline.durationSec);
  timeline = applyTimelinePatch(timeline, "set_music_bed", undefined, { assetId: bed.id, volume: 0.6, duckTo: 0.22 });

  await patchProject(userId, projectId, { timeline });
  project = await getOwnedProjectOrThrow(userId, projectId);
  return { project, timeline: project.timeline!, created: true };
}
