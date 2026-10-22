import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { getNeuralRuntime } from "./runtime";
import { capturerSnapshot } from "./generation/snapshot";
import { genererVisuelNeural, visuelVersDataUri } from "./generation/visual-engine";
import { genererAudioNeural, audioVersDataUri } from "./generation/audio-engine";
import { genererVideoNeural, videoVersDataUri } from "./generation/video-engine";
import {
  analyserScene,
  analyserScenesMultiples,
  sceneRendable,
  type SceneSpec,
} from "./generation/scene-spec";
import { genererVisuelScene } from "./generation/visual-scene";
import { genererAudioScene, sceneSonore } from "./generation/audio-composition";
import { genererVideoScene } from "./generation/video-storyboard";
import { lexiqueMultimodal } from "./generation/lexique-serveur";
import type { NeuralSnapshot } from "./generation/snapshot";
import { persistGeneratedBuffer } from "@/lib/media/persist";
import { headR2Object, isR2Configured, createR2DownloadUrl } from "@/lib/storage/r2";
import type { ImageRatio } from "@/lib/ai/image-intent";
import { IMAGE_RATIOS } from "@/lib/ai/image-intent";

/**
 * SERVICE MÉDIA NEURONAL — génération + persistance + CACHE DE CONTENU.
 *
 * Point d'entrée serveur pour les créations du corps sémantique :
 * l'état RÉEL du cerveau (poids appris) est capturé, le moteur local
 * produit le contenu (SVG / WAV / SVG animé), puis la sortie est
 * archivée dans le stockage PERMANENT de l'utilisateur (R2, même
 * convention de clés que le chat historique).
 *
 * Aucune IA externe n'est appelée — la génération est 100 % locale et
 * déterministe (prompt + état neuronal). Les compositions visuelles
 * sont rastérisées en PNG via sharp (compatibilité universelle :
 * affichage, pipeline vidéo ffmpeg, téléchargement).
 *
 * OPTIMISATION (audit multimodal) : le couple (prompt, état neuronal,
 * paramètres) est DÉTERMINISTE — la même demande sur le même état de
 * cerveau produit bit-à-bit le même rendu. Chaque demande calcule donc
 * une CLÉ DE CONTENU (empreinte SHA-256) et sonde R2 (HEAD) avant de
 * rendre : cache hit = URL signée immédiate, zéro re-render, zéro
 * re-upload. Sur les répétitions (cas le plus fréquent : même prompt
 * relancé, régénérations après incident), la latence tombe de plusieurs
 * centaines de ms (sharp + upload) à une requête HEAD.
 */

/** Résultat d'une génération média neuronale persistée. */
export interface MediaNeuralGenere {
  /** URL signée de la copie permanente R2 (ou data URI si R2 indisponible). */
  url: string;
  /** "r2" = archivage permanent réussi ; "inline" = repli data URI. */
  storage: "r2" | "inline";
  /** Type MIME du contenu généré. */
  mime: "image/png" | "image/svg+xml" | "audio/wav";
  /** Métadonnées réelles de génération (traçabilité honnête). */
  meta: Record<string, unknown>;
  /** Identifiant de génération (idempotence côté journalisation). */
  generationId: string;
  /**
   * Clé R2 PERMANENTE du contenu (users/<uid>/permanent/…) quand
   * storage === "r2" — handle durable, jamais expiré, réutilisable comme
   * storagePath d'artefact (contrat voice.speak / livrables).
   */
  cleStockage?: string;
}

/** Résultat brut d'une génération visuelle (avant persistance). */
export interface VisuelNeuralBrut {
  /** Image rastérisée (PNG via sharp ; SVG vectoriel en repli). */
  image: Buffer;
  /** Type MIME effectif du contenu livré. */
  mime: "image/png" | "image/svg+xml";
  /** Document SVG source (vectoriel, archivable). */
  svg: string;
  width: number;
  height: number;
  meta: Record<string, unknown>;
}

/** Ratio sûr (détection → liste supportée). */
function ratioSur(ratio?: string): ImageRatio {
  const candidat = ratio as ImageRatio | undefined;
  if (candidat && (IMAGE_RATIOS as readonly string[]).includes(candidat)) {
    return candidat;
  }
  return "1:1";
}

/**
 * Rastérise un SVG en PNG via sharp (repli SVG si sharp indisponible).
 *
 * Densité ADAPTATIVE (audit perf) : l'ancien rendu fixe `density: 300`
 * surchargeait ~4× la grille de pixels (intermédiaire ≈ 4× la taille
 * cible) avant réduction — CPU gaspillé sans gain visuel. La densité est
 * désormais calée sur le rapport largeur cible / largeur naturelle du SVG
 * (borné 72–300), et la compression passe de 9 à 6 (différence de poids
 * négligeable sur du vectoriel aplati, encodage nettement moins cher).
 */
async function rasteriser(
  svg: string,
  largeur: number,
): Promise<{ buffer: Buffer; mime: "image/png" | "image/svg+xml" }> {
  try {
    const { default: sharp } = await import("sharp");
    const cible = Math.min(2048, Math.max(512, Math.round(largeur)));
    const naturelle = /width="(\d+(?:\.\d+)?)"/.exec(svg);
    const densite = naturelle
      ? Math.min(300, Math.max(72, Math.round((72 * cible) / Number(naturelle[1]))))
      : 300;
    const buffer = await sharp(Buffer.from(svg, "utf-8"), { density: densite })
      .resize({ width: cible })
      .png({ compressionLevel: 6 })
      .toBuffer();
    return { buffer, mime: "image/png" };
  } catch (erreur) {
    console.warn(
      "[media-neural] rastérisation sharp indisponible — livraison SVG vectorielle :",
      erreur instanceof Error ? erreur.message : String(erreur),
    );
    return { buffer: Buffer.from(svg, "utf-8"), mime: "image/svg+xml" };
  }
}

/**
 * Empreinte de l'état neuronal capturé (identité de contenu du rendu) :
 * graine de composition, dimensions du réseau, poids moyen, histogramme.
 * Deux captures d'états différents produisent des empreintes différentes
 * — jamais de faux cache hit.
 */
function empreinteSnapshot(snapshot: NeuralSnapshot): string {
  return [
    snapshot.seed,
    snapshot.nbNeurones,
    snapshot.nbSynapses,
    snapshot.poidsMoyen.toFixed(6),
    snapshot.histogramme.map((v) => v.toFixed(4)).join(","),
  ].join("|");
}

/**
 * Clé de contenu DÉTERMINISTE du média caché :
 *   users/<uid>/permanent/neural-media/cache/<type>-<sha256>.<ext>
 * La clé dérive du type, du prompt, des paramètres et de l'empreinte
 * neuronale — le même rendu est donc TOUJOURS la même clé R2.
 */
function cleCacheMedia(
  userId: string,
  type: "visuel" | "audio" | "video",
  ingredients: string,
  ext: string,
): string {
  const hash = createHash("sha256").update(ingredients).digest("hex").slice(0, 48);
  return `users/${userId}/permanent/neural-media/cache/${type}-${hash}.${ext}`;
}

/**
 * Tente un cache hit : si la clé de contenu existe déjà dans R2, renvoie
 * l'URL signée immédiate (aucun rendu, aucun upload). Retourne null sinon
 * (cache miss — l'appelant rend et archive normalement). Fail-soft total :
 * headR2Object ne lève jamais.
 */
async function tenterCacheMedia(
  userId: string,
  cle: string,
): Promise<string | null> {
  if (!isR2Configured()) return null;
  const present = await headR2Object(cle);
  if (!present || present.sizeBytes <= 0) return null;
  try {
    return await createR2DownloadUrl(cle, 3600);
  } catch {
    return null;
  }
}

/**
 * Analyse sémantique du prompt (lexique intégré + appris HORS
 * PRODUCTION). La couverture et les mots reconnus sont réels — le
 * repli v1 est assumé quand rien n'est reconnu.
 */
function analyserPromptScene(prompt: string): SceneSpec {
  return analyserScene(prompt, lexiqueMultimodal());
}

/** Méta commune des moteurs scéniques v2 (traçabilité honnête). */
function metaScene(scene: SceneSpec): Record<string, unknown> {
  return {
    scene: {
      sujet: scene.sujet?.type ?? null,
      sujetLabel: scene.sujet?.label ?? null,
      cadre: scene.cadre,
      moment: scene.moment,
      meteo: scene.meteo,
      style: scene.style,
      ambiance: scene.ambiance,
      couverture: Number(scene.couverture.toFixed(3)),
      motsReconnus: scene.motsReconnus.slice(0, 12),
    },
  };
}

/**
 * Génération visuelle brute : composition SVG calculée depuis l'état réel
 * du cerveau, rastérisée en PNG. Utilisée par le pipeline vidéo (assets de
 * scène) et par la persistance.
 *
 * MOTEUR V2 SCÉNIQUE : si l'analyse sémantique reconnaît un sujet ou un
 * cadre, l'illustration est composée en CALQUES (le sujet demandé est
 * DESSINÉ). Sinon, repli honnête sur la constellation neuronale v1.
 */
export async function genererVisuelNeuralBrut(params: {
  prompt: string;
  ratio?: string;
}): Promise<VisuelNeuralBrut> {
  const { reseau } = getNeuralRuntime();
  const prompt = params.prompt.trim().slice(0, 2000) || "Fractale neuronale abstraite";
  const snapshot = capturerSnapshot(reseau, prompt);
  const scene = analyserPromptScene(prompt);

  if (sceneRendable(scene)) {
    const rendu = genererVisuelScene(prompt, ratioSur(params.ratio), snapshot, scene);
    const raster = await rasteriser(rendu.svg, rendu.width);
    return {
      svg: rendu.svg,
      image: raster.buffer,
      mime: raster.mime,
      width: rendu.width,
      height: rendu.height,
      meta: {
        ...rendu.meta,
        ...metaScene(scene),
        largeur: rendu.width,
        hauteur: rendu.height,
        prompt,
        moteur: "gen3-snn-visuel-v2-scene",
      },
    };
  }

  const rendu = genererVisuelNeural(prompt, ratioSur(params.ratio), snapshot);
  const raster = await rasteriser(rendu.svg, rendu.width);

  return {
    svg: rendu.svg,
    image: raster.buffer,
    mime: raster.mime,
    width: rendu.width,
    height: rendu.height,
    meta: {
      ...rendu.meta,
      ...metaScene(scene),
      largeur: rendu.width,
      hauteur: rendu.height,
      prompt,
      moteur: "gen3-snn-visuel-v1-constellation",
    },
  };
}

/**
 * Génère et archive un VISUEL neural (composition calculée depuis l'état
 * réel du cerveau entraîné, livrée en PNG).
 *
 * Chemin optimal : cache de contenu (HEAD R2) → URL signée immédiate.
 * Cache miss : rendu → upload DIRECT du buffer (aucun détour Base64) sous
 * la clé déterministe → les demandes suivantes deviennent des cache hits.
 * Repli inline : data URI uniquement quand R2 est indisponible.
 */
export async function genererVisuelNeuralEtPersister(params: {
  userId: string;
  prompt: string;
  ratio?: string;
}): Promise<MediaNeuralGenere> {
  const { reseau } = getNeuralRuntime();
  const prompt = params.prompt.trim().slice(0, 2000) || "Fractale neuronale abstraite";
  const ratio = ratioSur(params.ratio);
  const snapshot = capturerSnapshot(reseau, prompt);
  const scene = analyserPromptScene(prompt);
  const sceneRendue = sceneRendable(scene);

  // Clé v2 : le contenu des rendus a changé (moteur scénique) — les
  // anciennes clés v1 ne doivent jamais masquer un nouveau rendu.
  const cleCache = cleCacheMedia(
    params.userId,
    "visuel",
    `visuel|v2|${prompt}|${ratio}|${empreinteSnapshot(snapshot)}`,
    "png",
  );
  const hit = await tenterCacheMedia(params.userId, cleCache);
  if (hit) {
    return {
      url: hit,
      storage: "r2",
      mime: "image/png",
      meta: {
        prompt,
        ratio,
        moteur: sceneRendue ? "gen3-snn-visuel-v2-scene" : "gen3-snn-visuel-v1-constellation",
        ...metaScene(scene),
        cache: "hit",
      },
      generationId: `visuel-${randomUUID()}`,
    };
  }

  const rendu = sceneRendue
    ? genererVisuelScene(prompt, ratio, snapshot, scene)
    : genererVisuelNeural(prompt, ratio, snapshot);
  const raster = await rasteriser(rendu.svg, rendu.width);
  const meta = {
    ...rendu.meta,
    ...metaScene(scene),
    largeur: rendu.width,
    hauteur: rendu.height,
    prompt,
    ratio,
    moteur: sceneRendue ? "gen3-snn-visuel-v2-scene" : "gen3-snn-visuel-v1-constellation",
    mime: raster.mime,
    cache: "miss",
  };

  // PNG rastérisé : upload direct du buffer sous la clé de contenu.
  // Repli SVG vectoriel (sharp absent) : même voie buffer, MIME adapté.
  const persiste = await persistGeneratedBuffer({
    userId: params.userId,
    buffer: raster.buffer,
    contentType: raster.mime,
    prefix: "neural-media",
    fixedKey: cleCache,
    fallbackUrl:
      raster.mime === "image/svg+xml"
        ? visuelVersDataUri(rendu.svg)
        : `data:${raster.mime};base64,${raster.buffer.toString("base64")}`,
  });

  return {
    url: persiste.url,
    storage: persiste.storage === "r2" ? "r2" : "inline",
    mime: raster.mime,
    meta,
    generationId: `visuel-${randomUUID()}`,
    ...(persiste.storagePath ? { cleStockage: persiste.storagePath } : {}),
  };
}

/**
 * Génère et archive un SIGNAL AUDIO scénique. MOTEUR V2 : quand la
 * scène est sonore (sons nommés, météo ou cadre reconnus), le design
 * sonore comporte des COUCHES sémantiques (pluie, vagues, vent…)
 * plus une musique structurée ; sinon repli honnête sur la nappe v1.
 * Cache de contenu sur (prompt, durée, fréquence, empreinte).
 */
export async function genererAudioNeuralEtPersister(params: {
  userId: string;
  prompt: string;
  dureeSecondes?: number;
  frequenceEchantillonnage?: number;
}): Promise<MediaNeuralGenere> {
  const { reseau } = getNeuralRuntime();
  const prompt = params.prompt.trim().slice(0, 2000) || "Signal d'harmonique pure et pulsation fluide";
  const duree = params.dureeSecondes ?? 3;
  const frequence = params.frequenceEchantillonnage ?? 22050;
  const snapshot = capturerSnapshot(reseau, prompt);
  const scene = analyserPromptScene(prompt);
  const sceneSonore2 = sceneSonore(scene);

  const cleCache = cleCacheMedia(
    params.userId,
    "audio",
    `audio|v2|${prompt}|${duree}|${frequence}|${empreinteSnapshot(snapshot)}`,
    "wav",
  );
  const hit = await tenterCacheMedia(params.userId, cleCache);
  if (hit) {
    return {
      url: hit,
      storage: "r2",
      mime: "audio/wav",
      meta: {
        duree,
        frequence,
        prompt,
        moteur: sceneSonore2 ? "gen3-snn-audio-v2-scene" : "gen3-snn-audio-v1-nappe",
        ...metaScene(scene),
        cache: "hit",
      },
      generationId: `audio-${randomUUID()}`,
    };
  }

  const rendu = sceneSonore2
    ? genererAudioScene(prompt, duree, frequence, snapshot, scene)
    : genererAudioNeural(prompt, duree, frequence, snapshot);

  const persiste = await persistGeneratedBuffer({
    userId: params.userId,
    buffer: rendu.wav,
    contentType: "audio/wav",
    prefix: "neural-media",
    fixedKey: cleCache,
    fallbackUrl: audioVersDataUri(rendu.wav),
  });

  return {
    url: persiste.url,
    storage: persiste.storage === "r2" ? "r2" : "inline",
    mime: "audio/wav",
    meta: {
      ...("couches" in rendu.meta ? rendu.meta : {}),
      ...metaScene(scene),
      duree: rendu.dureeSecondes,
      frequence: rendu.sampleRate,
      octets: rendu.wav.length,
      prompt,
      moteur: sceneSonore2 ? "gen3-snn-audio-v2-scene" : "gen3-snn-audio-v1-nappe",
      cache: "miss",
    },
    generationId: `audio-${randomUUID()}`,
    ...(persiste.storagePath ? { cleStockage: persiste.storagePath } : {}),
  };
}

/**
 * Génère et archive une ANIMATION SCÉNIQUE (storyboard v2 : les scènes
 * reconnues du prompt sont rendues puis animées — caméra, météo vivante,
 * transitions ; repli honnête sur la constellation pulsante v1).
 * Cache de contenu identique (SVG = texte déterministe).
 */
export async function genererVideoNeuralEtPersister(params: {
  userId: string;
  prompt: string;
  dureeSecondes?: number;
}): Promise<MediaNeuralGenere> {
  const { reseau } = getNeuralRuntime();
  const prompt = params.prompt.trim().slice(0, 2000) || "Transition fluide de structures neuronales";
  const duree = params.dureeSecondes ?? 4;
  const snapshot = capturerSnapshot(reseau, prompt);
  const scenesCandidates = analyserScenesMultiples(prompt, lexiqueMultimodal());
  const scenes = scenesCandidates.filter(sceneRendable);
  const storyboard = scenes.length > 0;

  const cleCache = cleCacheMedia(
    params.userId,
    "video",
    `video|v2|${prompt}|${duree}|${empreinteSnapshot(snapshot)}`,
    "svg",
  );
  const hit = await tenterCacheMedia(params.userId, cleCache);
  if (hit) {
    return {
      url: hit,
      storage: "r2",
      mime: "image/svg+xml",
      meta: {
        duree,
        prompt,
        moteur: storyboard ? "gen3-snn-video-v2-storyboard" : "gen3-snn-video-v1-constellation",
        ...(storyboard ? { nbScenes: scenes.length } : metaScene(scenesCandidates[0]!)),
        cache: "hit",
      },
      generationId: `video-${randomUUID()}`,
    };
  }

  const rendu = storyboard
    ? genererVideoScene(prompt, duree, snapshot, scenes)
    : genererVideoNeural(prompt, duree, snapshot);

  const persiste = await persistGeneratedBuffer({
    userId: params.userId,
    buffer: Buffer.from(rendu.svg, "utf-8"),
    contentType: "image/svg+xml",
    prefix: "neural-media",
    fixedKey: cleCache,
    fallbackUrl: videoVersDataUri(rendu.svg),
  });

  return {
    url: persiste.url,
    storage: persiste.storage === "r2" ? "r2" : "inline",
    mime: "image/svg+xml",
    meta: {
      ...rendu.meta,
      ...(storyboard ? { ...metaScene(scenes[0]!), scenesAnalysees: scenesCandidates.length } : {}),
      duree: rendu.dureeSecondes,
      largeur: rendu.width,
      hauteur: rendu.height,
      prompt,
      moteur: storyboard ? "gen3-snn-video-v2-storyboard" : "gen3-snn-video-v1-constellation",
      cache: "miss",
    },
    generationId: `video-${randomUUID()}`,
    ...(persiste.storagePath ? { cleStockage: persiste.storagePath } : {}),
  };
}
