import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { appendMessage } from "@/lib/chat/repository";
import { createArtifact } from "@/lib/domain/artifacts/repository";
import { produceConversationImage } from "@/lib/domain/conversations/engine-chat";

export const runtime = "nodejs";

/**
 * /api/media/webgpu-fallback — repli HONNÊTE quand le navigateur ne peut
 * pas exécuter la génération WebGPU (pas de WebGPU, VRAM insuffisante,
 * échec de téléchargement…). Le serveur reprend le tour avec ses propres
 * moteurs : image → moteur neuronal abstrait (SD externe supprimé du
 * projet — composition synaptique honnête) ; voix/vidéo → message
 * explicatif sans faux succès.
 */

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const body = (await request.json()) as {
      jobId?: string;
      conversationId?: string;
      kind?: "image" | "voice" | "video";
      prompt?: string;
      ratio?: string;
      durationSeconds?: number;
      raison?: string;
    };
    const { conversationId, kind, prompt } = body;
    const userId = guard.context.userId;
    if (!conversationId || !kind) {
      return NextResponse.json(
        { success: false, error: "conversationId et kind requis." },
        { status: 400 },
      );
    }
    const raison = (body.raison ?? "WebGPU indisponible").slice(0, 200);

    if (kind === "image" && prompt) {
      // Repli réel : moteur neuronal abstrait du serveur (aucune IA externe).
      const image = await produceConversationImage({ message: prompt, userId }, prompt);
      const message = await appendMessage({
        conversationId,
        userId,
        role: "assistant",
        content:
          `Votre navigateur ne peut pas exécuter la génération WebGPU (${raison}). ` +
          "Je vous livre la composition de mon moteur neuronal interne — une composition abstraite, honnête, calculée depuis mon état synaptique.",
        imageUrl: image.inlineDataUrl ?? image.imageUrl,
        provider: "gen3-snn",
        model: image.model,
        generationStatus: "complete",
      });
      const artifact = await createArtifact({
        userId,
        conversationId,
        type: "image",
        title: prompt.slice(0, 80),
        url: image.inlineDataUrl ?? image.imageUrl,
        storagePath: image.storagePath,
        note: `Repli neuronal (WebGPU indisponible : ${raison})`,
      });
      return NextResponse.json({ success: true, message, artifact });
    }

    // Voix / vidéo : pas de repli trompeur — explication + alternatives réelles.
    const message = await appendMessage({
      conversationId,
      userId,
      role: "assistant",
      content:
        kind === "voice"
          ? `La synthèse vocale humaine s'exécute dans votre navigateur (WebGPU) — or il est indisponible ici (${raison}). ` +
            "Alternatives : ouvrez gen3ia.online dans Chrome/Edge récent, ou utilisez la lecture native du navigateur (haut-parleur du message)."
          : `La vidéo photoréaliste exige WebGPU pour les keyframes (${raison}). ` +
            "Alternatives : Chrome/Edge récent côté client, ou la production vidéo autopilote du serveur (pipeline lib/video, moteur neuronal abstrait).",
      provider: "gen3",
      model: "gen3-fallback",
      generationStatus: "complete",
    });
    return NextResponse.json({ success: true, message });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Repli échoué" },
      { status: 500 },
    );
  }
}
