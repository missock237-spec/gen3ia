import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { persistGeneratedBuffer } from "@/lib/media/persist";
import { appendMessage } from "@/lib/chat/repository";
import { createArtifact } from "@/lib/domain/artifacts/repository";

export const runtime = "nodejs";

/**
 * /api/media/webgpu-complete — persistance d'un média généré SUR LE GPU DE
 * L'UTILISATEUR (WebGPU : SD photoréalisme, Kokoro voix, vidéo keyframes).
 *
 * Le navigateur envoie le blob (multipart) ; le serveur :
 *  1. archive en R2 PERMANENT (users/<uid>/permanent/webgpu-* — même
 *     convention de clés que le reste de la plateforme) ;
 *  2. persiste le message assistant avec l'URL signée ;
 *  3. crée l'artefact conversation (bibliothèque de fichiers).
 *
 * Sécurité : route protégée (session), propriétaire forcé = utilisateur
 * authentifié, taille plafonnée (25 Mo — PNG/MP4/WAV navigateur).
 */

const MAX_BYTES = 25 * 1024 * 1024;

const MIME_PAR_KIND: Record<string, string> = {
  image: "image/png",
  voice: "audio/wav",
  video: "video/mp4",
};

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const form = await request.formData();
    const jobId = String(form.get("jobId") ?? "");
    const conversationId = String(form.get("conversationId") ?? "");
    const kind = String(form.get("kind") ?? "");
    const prompt = String(form.get("prompt") ?? "").slice(0, 4000);
    const metaBrut = String(form.get("meta") ?? "{}");
    const file = form.get("file");

    if (!jobId || !conversationId || !MIME_PAR_KIND[kind]) {
      return NextResponse.json(
        { success: false, error: "Paramètres incomplets (jobId, conversationId, kind requis)." },
        { status: 400 },
      );
    }
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ success: false, error: "Fichier média absent." }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { success: false, error: "Média trop volumineux (25 Mo max)." },
        { status: 413 },
      );
    }

    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(metaBrut) as Record<string, unknown>;
    } catch {
      meta = {};
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const prefix = kind === "image" ? "webgpu-images" : kind === "voice" ? "webgpu-voix" : "webgpu-video";
    const persisté = await persistGeneratedBuffer({
      userId: guard.context.userId,
      buffer,
      contentType: MIME_PAR_KIND[kind],
      prefix,
      fallbackUrl: "",
    });

    const libellé =
      kind === "image"
        ? "Image photoréaliste générée sur votre GPU (WebGPU) — 100 % locale, aucun serveur d'IA externe."
        : kind === "voice"
          ? "Voix humaine synthétisée sur votre appareil (Kokoro, moteur WebGPU local)."
          : "Vidéo assemblée localement (keyframes WebGPU + fondus ffmpeg).";

    const métaTexte = Object.entries(meta)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .slice(0, 6)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(" · ");

    const message = await appendMessage({
      conversationId,
      userId: guard.context.userId,
      role: "assistant",
      content: `${libellé}${métaTexte ? `\n\n${métaTexte}` : ""}`,
      imageUrl: kind === "image" ? persisté.url : undefined,
      provider: "gen3-webgpu",
      model: "gen3-media-engine-v1",
      generationStatus: "complete",
    });

    const artifact = await createArtifact({
      userId: guard.context.userId,
      conversationId,
      type: kind === "image" ? "image" : kind === "voice" ? "audio" : "video",
      title: prompt.slice(0, 80) || `Média WebGPU ${jobId.slice(0, 8)}`,
      url: persisté.url,
      storagePath: persisté.storagePath,
      note: `Généré sur le GPU de l'utilisateur (WebGPU)${métaTexte ? ` — ${métaTexte}` : ""}`,
    });

    return NextResponse.json({ success: true, message, artifact });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Persistance échouée" },
      { status: 500 },
    );
  }
}
