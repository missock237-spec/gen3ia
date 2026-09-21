import { InferenceClient } from "@huggingface/inference";

import { billUsage } from "@/lib/billing/media-meter";
import { storePermanentFile } from "@/lib/storage/permanent-user-storage";

import { formatHint, type VideoFormat } from "./types";

/**
 * Images clés IA des scènes vidéo : génération text-to-image via HuggingFace
 * (déjà utilisé pour les embeddings de la plateforme), stockage dans l'espace
 * permanent de l'utilisateur et facturation au métre média existant
 * (image_generation). Si HF_TOKEN est absent, l'erreur est explicite :
 * le storyboard reste utilisable sans images.
 */

const DEFAULT_MODEL = "black-forest-labs/FLUX.1-schnell";

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 40) || "scene";
}

export async function generateSceneKeyframe(params: {
  userId: string;
  projectId: string;
  sceneId: string;
  sceneTitle: string;
  visualPrompt: string;
  format: VideoFormat;
}): Promise<{ path: string; filename: string; model: string }> {
  if (!process.env.HF_TOKEN) {
    throw new Error("La génération d'images clés nécessite HF_TOKEN sur la plateforme. Le storyboard reste éditable sans images.");
  }
  const model = process.env.HF_TEXT_IMAGE_MODEL || DEFAULT_MODEL;

  const prompt = `${params.visualPrompt.trim()}, ${formatHint(params.format)}, professional cinematic lighting, high detail, no text overlay`;

  const client = new InferenceClient(process.env.HF_TOKEN);
  const output = await client.textToImage(
    { model, inputs: prompt.slice(0, 1_000) },
    { outputType: "blob" },
  );
  // Défense : certains backends renvoient une URL au lieu d'un blob.
  const content = typeof output === "string"
    ? Buffer.from(await (await fetch(output)).arrayBuffer())
    : Buffer.from(await output.arrayBuffer());

  const filename = `keyframe-${slugify(params.sceneTitle || params.sceneId)}.png`;
  const stored = await storePermanentFile({
    userId: params.userId,
    filename,
    content,
    contentType: "image/png",
    metadata: { kind: "video-keyframe", projectId: params.projectId, sceneId: params.sceneId },
  });

  // Facturation média après succès (réservation + règlement atomiques).
  try {
    await billUsage({
      userId: params.userId,
      executionId: `video_${params.projectId}`,
      kind: "image_generation",
      quantity: 1,
      metadata: { projectId: params.projectId, sceneId: params.sceneId, model },
    });
  } catch {
    // Le portefeuille ne bloque pas la livraison d'une image déjà générée :
    // l'écart sera couvert par le prochain cycle de facturation.
  }

  return { path: stored.path, filename: stored.filename, model };
}
