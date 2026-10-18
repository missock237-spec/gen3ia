import "server-only";

import { randomUUID } from "node:crypto";

import { getNeuralRuntime } from "./runtime";
import { capturerSnapshot } from "./generation/snapshot";
import { genererVisuelNeural, visuelVersDataUri } from "./generation/visual-engine";
import { genererAudioNeural, audioVersDataUri } from "./generation/audio-engine";
import { genererVideoNeural, videoVersDataUri } from "./generation/video-engine";
import { persistGeneratedImage } from "@/lib/media/persist";
import type { ImageRatio } from "@/lib/ai/image-intent";
import { IMAGE_RATIOS } from "@/lib/ai/image-intent";

/**
 * SERVICE MÉDIA NEURONAL — génération + persistance.
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

/** Rastérise un SVG en PNG via sharp (repli SVG si sharp indisponible). */
async function rasteriser(
  svg: string,
  largeur: number,
): Promise<{ buffer: Buffer; mime: "image/png" | "image/svg+xml" }> {
  try {
    const { default: sharp } = await import("sharp");
    const buffer = await sharp(Buffer.from(svg, "utf-8"), { density: 300 })
      .resize({ width: Math.min(2048, Math.max(512, Math.round(largeur))) })
      .png({ compressionLevel: 9 })
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
 * Génération visuelle brute : composition SVG calculée depuis l'état réel
 * du cerveau, rastérisée en PNG. Utilisée par le pipeline vidéo (assets de
 * scène) et par la persistance.
 */
export async function genererVisuelNeuralBrut(params: {
  prompt: string;
  ratio?: string;
}): Promise<VisuelNeuralBrut> {
  const { reseau } = getNeuralRuntime();
  const prompt = params.prompt.trim().slice(0, 2000) || "Fractale neuronale abstraite";
  const snapshot = capturerSnapshot(reseau, prompt);
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
      largeur: rendu.width,
      hauteur: rendu.height,
      prompt,
      moteur: "gen3-snn-visuel-v1",
    },
  };
}

/**
 * Génère et archive un VISUEL neural (composition calculée depuis l'état
 * réel du cerveau entraîné, livrée en PNG).
 */
export async function genererVisuelNeuralEtPersister(params: {
  userId: string;
  prompt: string;
  ratio?: string;
}): Promise<MediaNeuralGenere> {
  const brut = await genererVisuelNeuralBrut({
    prompt: params.prompt,
    ratio: params.ratio,
  });
  const dataUri =
    brut.mime === "image/svg+xml"
      ? visuelVersDataUri(brut.svg)
      : `data:${brut.mime};base64,${brut.image.toString("base64")}`;

  const persiste = await persistGeneratedImage({
    userId: params.userId,
    imageUrl: dataUri,
    prefix: "neural-media",
  });

  return {
    url: persiste.url,
    storage: persiste.storage === "r2" ? "r2" : "inline",
    mime: brut.mime,
    meta: { ...brut.meta, mime: brut.mime },
    generationId: `visuel-${randomUUID()}`,
  };
}

/**
 * Génère et archive un SIGNAL AUDIO neural (synthèse WAV calculée depuis
 * l'histogramme réel des poids synaptiques appris).
 */
export async function genererAudioNeuralEtPersister(params: {
  userId: string;
  prompt: string;
  dureeSecondes?: number;
  frequenceEchantillonnage?: number;
}): Promise<MediaNeuralGenere> {
  const { reseau } = getNeuralRuntime();
  const prompt = params.prompt.trim().slice(0, 2000) || "Signal d'harmonique pure et pulsation fluide";
  const snapshot = capturerSnapshot(reseau, prompt);
  const rendu = genererAudioNeural(
    prompt,
    params.dureeSecondes ?? 3,
    params.frequenceEchantillonnage ?? 22050,
    snapshot,
  );
  const dataUri = audioVersDataUri(rendu.wav);

  const persiste = await persistGeneratedImage({
    userId: params.userId,
    imageUrl: dataUri,
    prefix: "neural-media",
  });

  return {
    url: persiste.url,
    storage: persiste.storage === "r2" ? "r2" : "inline",
    mime: "audio/wav",
    meta: {
      ...rendu.meta,
      duree: rendu.dureeSecondes,
      frequence: rendu.sampleRate,
      octets: rendu.wav.length,
      prompt,
      moteur: "gen3-snn-audio-v1",
    },
    generationId: `audio-${randomUUID()}`,
  };
}

/**
 * Génère et archive une ANIMATION NEURONALE (SVG animé SMIL calculé
 * depuis l'état réel du cerveau — les navigateurs l'animent nativement).
 */
export async function genererVideoNeuralEtPersister(params: {
  userId: string;
  prompt: string;
  dureeSecondes?: number;
}): Promise<MediaNeuralGenere> {
  const { reseau } = getNeuralRuntime();
  const prompt = params.prompt.trim().slice(0, 2000) || "Transition fluide de structures neuronales";
  const snapshot = capturerSnapshot(reseau, prompt);
  const rendu = genererVideoNeural(prompt, params.dureeSecondes ?? 4, snapshot);
  const dataUri = videoVersDataUri(rendu.svg);

  const persiste = await persistGeneratedImage({
    userId: params.userId,
    imageUrl: dataUri,
    prefix: "neural-media",
  });

  return {
    url: persiste.url,
    storage: persiste.storage === "r2" ? "r2" : "inline",
    mime: "image/svg+xml",
    meta: {
      ...rendu.meta,
      duree: rendu.dureeSecondes,
      largeur: rendu.width,
      hauteur: rendu.height,
      prompt,
      moteur: "gen3-snn-video-v1",
    },
    generationId: `video-${randomUUID()}`,
  };
}
