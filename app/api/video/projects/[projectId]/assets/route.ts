import { NextRequest, NextResponse } from "next/server";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { registerAsset, listAssets } from "@/lib/video/asset-service";
import { getOwnedProjectOrThrow } from "@/lib/video/project-service";
import { probeMedia } from "@/lib/video/ffmpeg";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ projectId: string }> };

const UploadSchema = z.object({
  kind: z.enum(["image", "video", "audio_music", "audio_sfx", "audio_narration", "document"]),
  label: z.string().min(1).max(200),
  contentType: z.string().min(3).max(120),
  sceneId: z.string().max(80).optional(),
});

/**
 * Media Library — import utilisateur (images, vidéos, musique, SFX).
 * Les gros fichiers passent par le canal R2 multipart présigné du module
 * fichiers ; ici on accepte aussi le FormData direct (≤ limite serveur).
 */
export async function POST(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-assets-upload", rateLimit: { limit: 20, windowMs: 10 * 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    await getOwnedProjectOrThrow(guard.context.userId, projectId);
    const form = await request.formData();
    const file = form.get("file");
    const metaRaw = form.get("meta");
    if (!(file instanceof Blob)) throw new Error("Fichier manquant (champ « file »).");
    if (typeof metaRaw !== "string") throw new Error("Métadonnées manquantes (champ « meta » JSON).");
    const meta = UploadSchema.parse(JSON.parse(metaRaw));
    const body = Buffer.from(await file.arrayBuffer());
    const asset = await registerAsset({
      userId: guard.context.userId,
      projectId,
      kind: meta.kind,
      label: meta.label,
      sceneId: meta.sceneId,
      origin: "uploaded",
      contentType: meta.contentType,
      body,
    });
    return NextResponse.json({ asset }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Import impossible" }, { status: errorStatus(error, 400) });
  }
}

export async function GET(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-assets-list2", rateLimit: { limit: 120, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const assets = await listAssets(guard.context.userId, projectId);
    return NextResponse.json({ assets });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Liste impossible" }, { status: errorStatus(error, 500) });
  }
}

/** Sonde ffprobe à la demande (diagnostic d'un média importé). */
export async function PUT(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-assets-probe", rateLimit: { limit: 20, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const { assetId } = z.object({ assetId: z.string().min(1).max(120) }).parse(await request.json());
    const { getAsset, patchAssetMedia, downloadAssetContent } = await import("@/lib/video/asset-service");
    const asset = await getAsset(guard.context.userId, assetId);
    if (!asset || asset.projectId !== projectId) throw new Error("Asset introuvable.");
    const body = await downloadAssetContent(guard.context.userId, asset);
    const dir = await mkdtemp(join(tmpdir(), "gen3ia-probe-"));
    try {
      const ext = asset.contentType.includes("mp4") ? ".mp4" : asset.contentType.includes("webm") ? ".webm" : asset.contentType.includes("wav") ? ".wav" : asset.contentType.includes("mpeg") ? ".mp3" : ".bin";
      const path = join(dir, `probe${ext}`);
      await writeFile(path, body);
      const media = await probeMedia(path, dir);
      await patchAssetMedia(guard.context.userId, assetId, media);
      return NextResponse.json({ media });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Sonde impossible" }, { status: errorStatus(error, 400) });
  }
}
