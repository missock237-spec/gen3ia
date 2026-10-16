import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { getOwnedProjectOrThrow } from "@/lib/video/project-service";
import { generateAllSceneVideos, isSceneVideoServiceEnabled } from "@/lib/video/scene-video-service";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ projectId: string }> };

const GenerateSchema = z.object({
  /** Scènes cibles (max 4 par appel — chaînage par le client pour les lots). */
  sceneIds: z.array(z.string().min(1).max(80)).max(4).optional(),
  /** Force la régénération même si un clip existe déjà. */
  force: z.boolean().default(false),
});

/**
 * Task 154 — Scene Video Generation : génère les CLIPS VIDÉO IA des scènes
 * demandées (Agnes Video 2.5, mode keyframe depuis l'image cohérente de la
 * scène). Facturation portefeuille par clip (réservation avant, règlement
 * au réel — 402 si solde insuffisant). Chaînage : le client rappelle cette
 * route jusqu'à épuisement, comme pour les images.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-generate-videos", rateLimit: { limit: 30, windowMs: 10 * 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const { sceneIds, force } = GenerateSchema.parse(await request.json().catch(() => ({})));
    if (!isSceneVideoServiceEnabled()) {
      return NextResponse.json(
        { error: "La génération de clips vidéo IA n'est pas configurée sur cette plateforme (AGNES_API_KEY manquante ou levier désactivé)." },
        { status: 503 },
      );
    }
    const project = await getOwnedProjectOrThrow(guard.context.userId, projectId);
    if (!project.script) throw new Error("Générez d'abord le scénario.");
    const result = await generateAllSceneVideos({ userId: guard.context.userId, project, sceneIds, force });
    const remaining = project.script.scenes
      .filter((s) => !sceneIds || sceneIds.includes(s.id))
      .length;
    // Solde insuffisant sur TOUTES les scènes demandées → 402 explicite (le
    // client peut proposer la recharge) ; échecs partiels → 200 avec détails.
    const insufficientFunds = result.failed > 0
      && result.generated === 0
      && result.results.every((r) => r.status !== "failed" || /insufficient|fonds|solde|wallet/i.test(r.error ?? ""));
    if (insufficientFunds) {
      return NextResponse.json(
        {
          error: "Solde insuffisant pour générer les clips vidéo IA. Rechargeez votre portefeuille Gen3ia.",
          code: "PAYMENT_REQUIRED",
          ...result,
          scenesConsidered: remaining,
        },
        { status: 402 },
      );
    }
    return NextResponse.json({ ...result, scenesConsidered: remaining });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Génération de clips vidéo impossible" }, { status: errorStatus(error, 500) });
  }
}
