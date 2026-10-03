import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { getOwnedProjectOrThrow } from "@/lib/video/project-service";
import { buildTimelineFromScript, syncVoiceTrack, applyTimelinePatch, type TimelinePatchOp } from "@/lib/video/timeline-service";
import { TimelinePatchSchema } from "@/lib/video/security";
import { listAssets } from "@/lib/video/asset-service";
import { ensureMusicBed } from "@/lib/video/audio-engine";

export const runtime = "nodejs";

type Params = { params: Promise<{ projectId: string }> };

/** Timeline multi-pistes — initialisée paresseusement depuis le scénario. */
export async function GET(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-timeline-get", rateLimit: { limit: 120, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const { patchProject } = await import("@/lib/video/project-service");
    let project = await getOwnedProjectOrThrow(guard.context.userId, projectId);
    if (!project.timeline) {
      if (!project.script) throw new Error("Générez d'abord le scénario.");
      const shortForm = project.aspectRatio === "9:16";
      let timeline = buildTimelineFromScript(project, { shortForm, captionsStyle: shortForm ? "shorts_bold" : "documentary" });
      // Narrations disponibles → piste VOIX synchronisée + musique posée.
      const narrations = await listAssets(guard.context.userId, projectId, "audio_narration");
      const byScene = new Map(narrations.filter((a) => a.sceneId).map((a) => [a.sceneId!, a]));
      timeline = syncVoiceTrack(
        timeline,
        project.script.scenes
          .filter((s) => byScene.has(s.id))
          .map((s) => ({ sceneId: s.id, assetId: byScene.get(s.id)!.id, startSec: s.startSec, durationSec: Math.min(s.durationSec, byScene.get(s.id)!.media?.durationSec ?? s.durationSec) })),
      );
      const bed = await ensureMusicBed(guard.context.userId, projectId, project.musicMood ?? "documentaire", timeline.durationSec);
      timeline = applyTimelinePatch(timeline, "set_music_bed", undefined, { assetId: bed.id, volume: 0.6, duckTo: 0.22 });
      await patchProject(guard.context.userId, projectId, { timeline });
      project = await getOwnedProjectOrThrow(guard.context.userId, projectId);
    }
    return NextResponse.json({ timeline: project.timeline });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Timeline indisponible" }, { status: errorStatus(error, 400) });
  }
}

/** Opération d'édition typée (agent conversationnel ET panneau timeline). */
export async function PATCH(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-timeline-patch", rateLimit: { limit: 90, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const { op, clipId, payload } = TimelinePatchSchema.parse(await request.json());
    const project = await getOwnedProjectOrThrow(guard.context.userId, projectId);
    if (!project.timeline) throw new Error("Timeline absente — ouvrez d'abord la timeline.");
    const { snapshotVersion, patchProject: patchProjectSrv } = await import("@/lib/video/project-service");
    await snapshotVersion(guard.context.userId, projectId, "Édition timeline", "user");
    const timeline = applyTimelinePatch(project.timeline, op as TimelinePatchOp, clipId, payload);
    await patchProjectSrv(guard.context.userId, projectId, { timeline });
    return NextResponse.json({ timeline });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Édition impossible" }, { status: errorStatus(error, 400) });
  }
}
