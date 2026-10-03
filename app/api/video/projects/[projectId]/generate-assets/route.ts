import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { getOwnedProjectOrThrow } from "@/lib/video/project-service";
import { listAssets } from "@/lib/video/asset-service";
import { generateAllSceneImages } from "@/lib/video/image-bridge";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ projectId: string }> };

const GenerateSchema = z.object({
  /** Scènes cibles (max 4 par appel — chaînage par le client pour les lots). */
  sceneIds: z.array(z.string().min(1).max(80)).max(4).optional(),
  /** Force la régénération même si une image existe déjà. */
  force: z.boolean().default(false),
});

/**
 * Image Generation Bridge : génère les images des scènes demandées avec le
 * modèle d'images Gen3ia + Consistency Engine (références de personnages/
 * lieux). Chaînage : le client rappelle cette route jusqu'à épuisement.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-generate-assets", rateLimit: { limit: 30, windowMs: 10 * 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const { sceneIds, force } = GenerateSchema.parse(await request.json().catch(() => ({})));
    const project = await getOwnedProjectOrThrow(guard.context.userId, projectId);
    if (!project.script) throw new Error("Générez d'abord le scénario.");
    const result = await generateAllSceneImages({ userId: guard.context.userId, project, sceneIds, force });
    const remaining = project.script.scenes
      .filter((s) => !sceneIds || sceneIds.includes(s.id))
      .length;
    return NextResponse.json({ ...result, scenesConsidered: remaining });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Génération d'images impossible" }, { status: errorStatus(error, 500) });
  }
}

export async function GET(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-assets-list", rateLimit: { limit: 120, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const assets = await listAssets(guard.context.userId, projectId);
    return NextResponse.json({ assets });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Liste impossible" }, { status: errorStatus(error, 500) });
  }
}
