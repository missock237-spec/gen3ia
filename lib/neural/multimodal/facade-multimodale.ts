/**
 * FAÇADE MULTIMODALE — Gen3 nouvelle génération.
 *
 * Un prompt utilisateur → une LIVRAISON COMPLÈTE : image, voix, vidéo,
 * chacune avec son niveau de réalisme HONNÊTE et son fournisseur. Les
 * fournisseurs réels (diffusion / TTS neuronal / vidéo frontière) se
 * branchent par interface — sans eux, les générateurs structurels locaux
 * produisent des fichiers réels (PNG/WAV/AVI décodables) immédiatement.
 */

import { planifierScene, planifierVideo, type PlanScene } from "./encodeur-prompt-scene";
import { genererImage, type FournisseurImages, type RenduImage } from "./generateur-images";
import { genererVoix, type FournisseurVoix, type ProfilVoix } from "./generateur-voix";
import { genererVideo, type FournisseurVideo, type RenduVideo } from "./generateur-video";

export interface LivraisonMultimodale {
  image: RenduImage;
  audio: { wav: Buffer; niveauRealisme: "structurel-local" | "photoréaliste-réseau"; fournisseur: string };
  video: RenduVideo;
  plan: PlanScene;
  /** Texte prononcé : le prompt lu par la voix de Gen3. */
  textePrononce: string;
}

export interface FournisseursMultimodaux {
  images?: FournisseurImages;
  voix?: FournisseurVoix;
  video?: FournisseurVideo;
}

/**
 * Crée la livraison complète d'un prompt. Le profil de voix est requis
 * (capturé AVEC consentement) — sans profil, la voix par défaut est
 * générée à partir d'un profil neutre DECLARÉ (jamais d'imitation).
 */
export async function creerLivraisonMultimodale(prompt: string, profil: ProfilVoix, fournisseurs: FournisseursMultimodaux = {}, options: { dureeSecondes?: number; fps?: number; largeur?: number; hauteur?: number } = {}): Promise<LivraisonMultimodale> {
  const plan = planifierScene(prompt);
  const planVideo = planifierVideo(prompt, options.dureeSecondes ?? 4, options.fps ?? 8);
  const image = await genererImage(plan, fournisseurs.images, options.largeur ?? 512, options.hauteur ?? 384);
  const textePrononce = `Voici ${plan.sujet} : ${prompt}`;
  const audio = await genererVoix(textePrononce, profil, fournisseurs.voix);
  const video = await genererVideo(prompt, fournisseurs.video, options);
  return { image, audio, video, plan, textePrononce };
}
