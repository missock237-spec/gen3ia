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

import { genererVisuelNeuralBrut } from "@/lib/neural/media-service";
import { composeScenePrompt, bindReference } from "@/lib/video/consistency-engine";
import { registerAsset } from "@/lib/video/asset-service";
import type { VideoProject, ScriptScene, VisualBible, VideoAsset } from "@/lib/video/types";
import { VIDEO_LIMITS, VideoQuotaError } from "@/lib/video/security";

/** Ratios Agnes réellement supportés. */
function agnesRatio(aspect: VideoProject["aspectRatio"]): "1:1" | "3:4" | "4:3" | "16:9" | "9:16" | "2:3" | "3:2" | "21:9" {
  if (aspect === "4:5") return "3:4"; // vertical proche
  return aspect;
}

export interface SceneImageResult {
  sceneId: string;
  assetId: string;
  generated: boolean;
  reused: boolean;
}

/**
 * Génère (ou réutilise) l'image d'une scène :
 * - une image déjà liée à la scène → réutilisée (idempotence, révisions) ;
 * - sinon → génération neuronale LOCALE enrichie par la bible visuelle.
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

  // Références visuelles liées (bible) : elles n'alimentent plus une
  // composition multi-images (modèle d'édition externe supprimé) mais
  // restent liées à la scène pour l'atelier — le compte enrichit le
  // prompt neuronal (continuité chromatique déterministe).
  let nbReferencesLiees = 0;
  for (const entityId of composed.referenceEntityIds.slice(0, 4)) {
    const entity = [...project.visualBible.characters, ...project.visualBible.locations]
      .find((e) => e.id === entityId);
    if (entity?.referenceAssetId) nbReferencesLiees += 1;
  }

  // GÉNÉRATION NEURONALE LOCALE (les imageurs externes Agnes/HF ont été
  // supprimés du projet) : la composition visuelle est calculée depuis
  // l'état réel du cerveau Gen3 (poids synaptiques appris) et rastérisée
  // en PNG. La continuité visuelle entre scènes repose sur la graine
  // déterministe dérivée du prompt composé (mêmes entités → même identité
  // chromatique) — honnête, aucune IA externe.
  const referenceContext = nbReferencesLiees > 0
    ? ` ${nbReferencesLiees} référence(s) visuelle(s) liée(s)`
    : "";
  const rendu = await genererVisuelNeuralBrut({
    prompt: `${composed.prompt}${referenceContext}`,
    ratio: agnesRatio(project.aspectRatio),
  });
  const contentType = rendu.mime;
  const body = rendu.image;

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

/** Budget d'images par projet (plafond strict, spec §28) — Task 159 : lecture
 * d'index SEULE (1 doc), plus AUCUN scan de collection utilisateur. */
async function assertProjectImageBudget(userId: string, projectId: string): Promise<void> {
  const { countGeneratedProjectAssets } = await import("@/lib/video/asset-service");
  const count = await countGeneratedProjectAssets(userId, projectId, "image");
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
