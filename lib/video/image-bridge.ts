import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 5 : Image Generation Bridge.
 *
 * N'invente PAS un deuxième système d'images (spécification §7) : il
 * adapte le modèle d'images déjà présent dans Gen3ia (Agnes, via
 * lib/ai/image-generation) au pipeline vidéo, scène par scène, avec le
 * Consistency Engine en plus :
 *
 *   Video Agent → ImageGenerationService (Agnes) → Image → Asset Manager
 *
 * Cohérence : la première image d'une entité (personnage/lieu) devient sa
 * référence canonique ; les scènes suivantes qui mentionnent l'entité sont
 * générées PAR COMPOSITION (référence + prompt scène) via
 * editImageWithAgnes — les personnages ne changent plus d'une scène à
 * l'autre.
 */

import { generateImageWithAgnes, editImageWithAgnes, ImageGenerationError } from "@/lib/ai/image-generation";
import { composeScenePrompt, bindReference } from "@/lib/video/consistency-engine";
import { registerAsset, getAsset } from "@/lib/video/asset-service";
import { downloadAssetContent } from "@/lib/video/asset-service";
import type { VideoProject, ScriptScene, VisualBible, VideoAsset } from "@/lib/video/types";
import { VIDEO_LIMITS, VideoQuotaError } from "@/lib/video/security";

/** Ratios Agnes réellement supportés. */
function agnesRatio(aspect: VideoProject["aspectRatio"]): "1:1" | "3:4" | "4:3" | "16:9" | "9:16" | "2:3" | "3:2" | "21:9" {
  if (aspect === "4:5") return "3:4"; // vertical proche
  return aspect;
}

function sizeFor(resolution: VideoProject["resolution"]): "1K" | "2K" | "3K" | "4K" {
  switch (resolution) {
    case "480p":
    case "720p":
      return "1K";
    case "1080p":
      return "2K";
    case "1440p":
      return "3K";
    case "4K":
      return "4K";
  }
}

export interface SceneImageResult {
  sceneId: string;
  assetId: string;
  generated: boolean;
  reused: boolean;
}

async function downloadReferenceAsDataUri(userId: string, asset: VideoAsset): Promise<string> {
  const buffer = await downloadAssetContent(userId, asset);
  return `data:${asset.contentType};base64,${buffer.toString("base64")}`;
}

/**
 * Génère (ou réutilise) l'image d'une scène :
 * - une image déjà liée à la scène → réutilisée (idempotence, révisions) ;
 * - une entité avec référence → composition multi-images (cohérence) ;
 * - sinon → text-to-image enrichi par la bible visuelle.
 * La première image d'une entité devient sa référence canonique.
 */
export async function generateSceneImage(params: {
  userId: string;
  project: VideoProject;
  scene: ScriptScene;
  /** Réutilisation forcée même si une image existe (révision visuelle). */
  force?: boolean;
}): Promise<SceneImageResult> {
  const { userId, project, scene } = params;
  const composed = composeScenePrompt(project, scene);

  const existing = await findSceneImage(userId, project.id, scene.id);
  if (existing && !params.force) {
    return { sceneId: scene.id, assetId: existing.id, generated: false, reused: true };
  }

  await assertProjectImageBudget(userId, project.id);

  // Résolution des images de référence (max 4 — limite du modèle).
  const referenceUris: string[] = [];
  for (const entityId of composed.referenceEntityIds.slice(0, 4)) {
    const entity = [...project.visualBible.characters, ...project.visualBible.locations]
      .find((e) => e.id === entityId);
    if (!entity?.referenceAssetId) continue;
    const refAsset = await getAsset(userId, entity.referenceAssetId);
    if (!refAsset) continue;
    referenceUris.push(await downloadReferenceAsDataUri(userId, refAsset));
  }

  let imageUrl: string;
  try {
    if (referenceUris.length > 0) {
      const edited = await editImageWithAgnes({
        prompt: composed.prompt,
        images: referenceUris,
        size: sizeFor(project.resolution),
        ratio: agnesRatio(project.aspectRatio),
      });
      imageUrl = edited.imageUrl;
    } else {
      const generated = await generateImageWithAgnes({
        prompt: composed.prompt,
        size: sizeFor(project.resolution),
        ratio: agnesRatio(project.aspectRatio),
      });
      imageUrl = generated.imageUrl;
    }
  } catch (error) {
    if (error instanceof ImageGenerationError) {
      throw new Error(`Génération d'image (${scene.id}) : ${error.message}`);
    }
    throw error;
  }

  // Téléchargement de l'image générée puis enregistrement comme asset projet.
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Téléchargement de l'image (${scene.id}) : HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "image/png";
  const body = Buffer.from(await response.arrayBuffer());

  const asset = await registerAsset({
    userId,
    projectId: project.id,
    kind: "image",
    label: `Image ${scene.id}`,
    role: `scene:${scene.id}`,
    sceneId: scene.id,
    origin: "generated",
    contentType,
    body,
  });

  // La première image d'une entité mentionnée devient sa référence.
  let bible: VisualBible = project.visualBible;
  for (const entityId of composed.referenceEntityIds) {
    if (bible.characters.some((e) => e.id === entityId && e.referenceAssetId) ||
        bible.locations.some((e) => e.id === entityId && e.referenceAssetId)) {
      continue; // référence déjà établie
    }
    bible = bindReference(bible, entityId, asset.id);
  }
  // Si la scène mentionne des entités SANS référence, on établit la référence
  // canonique (première image = référence de l'entité pour toutes les suivantes).
  await persistBible(userId, project.id, bible);

  return { sceneId: scene.id, assetId: asset.id, generated: true, reused: false };
}

async function persistBible(userId: string, projectId: string, bible: VisualBible): Promise<void> {
  await patchAssetMediaBible(userId, projectId, bible);
}

async function patchAssetMediaBible(userId: string, projectId: string, bible: VisualBible): Promise<void> {
  const { patchProject } = await import("@/lib/video/project-service");
  await patchProject(userId, projectId, { visualBible: bible });
}

/** Budget d'images par projet (coûteux — plafond strict, spec §28). */
async function assertProjectImageBudget(userId: string, projectId: string): Promise<void> {
  const { adminDb } = await import("@/lib/firebase/admin");
  const snap = await adminDb
    .collection("videoAssets")
    .where("userId", "==", userId)
    .get();
  const count = snap.docs.filter((d) => {
    const data = d.data();
    return data?.projectId === projectId && data?.kind === "image" && data?.origin === "generated";
  }).length;
  if (count >= VIDEO_LIMITS.maxGeneratedImages) {
    throw new VideoQuotaError(`Plafond de ${VIDEO_LIMITS.maxGeneratedImages} images générées atteint pour ce projet.`);
  }
}

export async function findSceneImage(userId: string, projectId: string, sceneId: string): Promise<VideoAsset | null> {
  const { listAssets } = await import("@/lib/video/asset-service");
  const images = await listAssets(userId, projectId, "image");
  return images.find((a) => a.sceneId === sceneId && a.role === `scene:${sceneId}`) ?? null;
}

/**
 * Génération en lot : toutes les scènes sans image, séquentiellement
 * (le Consistency Engine a besoin des références des scènes précédentes).
 * Résiliente : une scène en échec n'arrête pas le lot — le rapport liste
 * les échecs à retenter.
 */
export async function generateAllSceneImages(params: {
  userId: string;
  project: VideoProject;
  sceneIds?: string[];
  /** Force la régénération même si une image existe. */
  force?: boolean;
  onScene?: (result: SceneImageResult) => void;
}): Promise<{ generated: number; reused: number; failed: Array<{ sceneId: string; error: string }> }> {
  const scenes = params.sceneIds
    ? params.project.script!.scenes.filter((s) => params.sceneIds!.includes(s.id))
    : params.project.script?.scenes ?? [];
  let generated = 0;
  let reused = 0;
  const failed: Array<{ sceneId: string; error: string }> = [];

  // Snapshot local du projet : la bible évolue à chaque scène (références
  // établies) — on relit le projet après chaque génération réussie pour que
  // la scène suivante bénéficie des références fraîches.
  let workingProject = params.project;
  for (const scene of scenes) {
    try {
      const result = await generateSceneImage({
        userId: params.userId,
        project: workingProject,
        scene,
        force: params.force,
      });
      if (result.generated) {
        generated += 1;
        const { getOwnedProjectOrThrow } = await import("@/lib/video/project-service");
        workingProject = await getOwnedProjectOrThrow(params.userId, params.project.id);
      } else {
        reused += 1;
      }
      params.onScene?.(result);
    } catch (error) {
      failed.push({ sceneId: scene.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { generated, reused, failed };
}
