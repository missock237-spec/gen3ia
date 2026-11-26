/**
 * GENAPI ADAPTATEURS — un adaptateur par service (mission PHASE 4-1) qui
 * délègue au CORE ENGINE réel (mission PHASE 4-3 : genAPI ne développe
 * AUCUNE logique décisionnelle concurrente — chaque adaptateur est un
 * relais normalisé : requête → Core → résultat → normalisation/erreurs).
 *
 * STATUTS RÉELS (règle 5 mission : jamais de fausse intégration) :
 *  · chat / reasoning / research : MOTEUR NEURONAL GEN3 réel
 *    (lib/ai/router.generate — le seul moteur du projet) ;
 *  · vision : moteur vision LIVE réel (mesures structurelles par pixels) ;
 *  · audio : mesures WAV réelles (comprendreAudioWav) — la TRANSCRIPTION
 *    n'existe pas dans le dépôt : déclarée bornée, jamais simulée ;
 *  · video / agents / automation / embeddings / training : INDISPONIBLES
 *    avec raison explicite (aucun moteur de ce type dans le dépôt).
 */

import { generate } from "@/lib/ai/router";
import type { AIRequest, AIResponse } from "@/lib/ai/models";
import { comprendreAudioWav } from "@/lib/neural/multimodal/comprehension-multimodale";
import { creerVisionEngine } from "@/lib/live/vision/vision-engine";

export type ReponseService =
  | { statut: "ok"; data: unknown }
  | { statut: "indisponible"; raison: string };

const RAZON_INDISPONIBLE = (service: string, pourquoi: string) =>
  `service « ${service} » indisponible : ${pourquoi} — capacité NON IMPLÉMENTÉE dans ce dépôt (déclarée, jamais simulée — mission PHASE 4)`;

const VIDEO_INDISPONIBLE = RAZON_INDISPONIBLE("video", "aucun moteur d'analyse ou de génération vidéo n'existe dans le dépôt");
const AGENTS_INDISPONIBLE = RAZON_INDISPONIBLE("agents", "l'exécution d'agents autonomes est couplée au canal agent Live (HITL + client PC), pas encore exposée en API publique — à connecter lors du PHASE 4 ultérieur");
const AUTOMATION_INDISPONIBLE = RAZON_INDISPONIBLE("automation", "aucun moteur de workflows n'existe dans le dépôt");
const EMBEDDINGS_INDISPONIBLE = RAZON_INDISPONIBLE("embeddings", "aucun modèle d'embedding local n'existe dans le dépôt (règle plateforme : aucun service IA externe)");
const TRAINING_INDISPONIBLE = RAZON_INDISPONIBLE("training", "mission : « lorsque le service sera disponible » — rien à connecter aujourd'hui");

/* ─────────────────────────── TEXTES (Core réel) ─────────────────────────── */

export interface EntreeTexte {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  maxTokens?: number;
}

/** Chat et reasoning passent par le MÊME moteur Gen3 (aucune logique parallèle). */
async function viaCoreGen3(service: "chat" | "reasoning" | "research", entree: EntreeTexte): Promise<ReponseService> {
  const requete: AIRequest = {
    task: service === "chat" ? "chat" : service,
    messages: entree.messages,
    temperature: entree.temperature,
    maxTokens: entree.maxTokens,
  };
  const reponse = await generate(requete);
  return { statut: "ok", data: normaliserReponseCore(reponse) };
}

/** Normalisation unique des réponses Core (mission PHASE 4-5). */
export function normaliserReponseCore(reponse: AIResponse): Record<string, unknown> {
  return {
    texte: reponse.text,
    modele: reponse.model ?? null,
    usage: reponse.usage ?? null,
  };
}

/* ─────────────────────────── VISION (moteur réel) ─────────────────────────── */

export interface EntreeVision {
  /** Image JPEG réelle envoyée par l'application (≤ 2 Mo). */
  jpeg: Buffer;
  /** Option : analyse comparative avec une image précédente. */
  jpegPrecedent?: Buffer;
}

/** Vision : moteur vision LIVE réel (scène + temporalité + OCR branchable). */
export async function viaVision(entree: EntreeVision): Promise<ReponseService> {
  // Session d'analyse à la demande : si une image précédente est fournie,
  // elle passe d'abord par le moteur (mémoire temporelle RÉELLE) pour que
  // la description de l'image courante porte le changement inter-images.
  const session = `genapi-${crypto.randomUUID().slice(0, 12)}`;
  const moteur = creerVisionEngine(session);
  if (entree.jpegPrecedent) await moteur.traiter(entree.jpegPrecedent);
  const desc = await moteur.traiter(entree.jpeg);
  if (!desc) {
    return { statut: "indisponible", raison: "image ignorée par le sélecteur de frames (aucun changement réel détecté — politique du moteur vision)" };
  }
  return {
    statut: "ok",
    data: {
      mesures: {
        proportionChangeePct: Math.round(desc.frame.proportionChangee * 10000) / 100,
        bandesTypeTexte: desc.scene.bandes.filter((b) => b.probableTexte).length,
        deplacement: desc.temporalite.deplacement,
      },
      interpretation: desc.interpretation,
      confiance: { score: desc.confiance.score, facteurs: desc.confiance.facteurs },
      ocr: {
        disponible: desc.ocr.disponible,
        textes: desc.ocr.textes ?? [],
        raisonIndisponibilite: desc.ocr.raisonIndisponibilite ?? null,
      },
    },
  };
}

/* ─────────────────────────── AUDIO (mesures réelles) ─────────────────────────── */

export interface EntreeAudio {
  /** WAV PCM16 mono réel envoyé par l'application (≤ 5 Mo). */
  wav: Buffer;
}

/** Audio : mesures réelles — la transcription est déclarée non disponible. */
export async function viaAudio(entree: EntreeAudio): Promise<ReponseService> {
  const mesures = comprendreAudioWav(entree.wav);
  return {
    statut: "ok",
    data: {
      mesures: {
        format: mesures.format,
        dureeSecondes: mesures.dureeSecondes,
        rms: mesures.rms,
        tauxPassageZero: mesures.tauxPassageZero,
        centreSpectralHz: mesures.centreSpectralHz,
        classe: mesures.classe,
      },
      transcription: null,
      note: "la transcription vocale n'est pas implémentée dans ce dépôt — mesures acoustiques réelles uniquement (déclaré, mission PHASE 4)",
    },
  };
}

/* ─────────────────────────── DISPATCH UNIQUE ─────────────────────────── */

/** Point d'entrée unique des adaptateurs : service → Core ou indisponible. */
export async function appelerServiceGenapi(service: "chat" | "reasoning" | "research" | "vision" | "audio" | "video" | "agents" | "automation" | "embeddings" | "training", entree: unknown): Promise<ReponseService> {
  switch (service) {
    case "chat":
    case "reasoning":
    case "research":
      return viaCoreGen3(service, entree as EntreeTexte);
    case "vision":
      return viaVision(entree as EntreeVision);
    case "audio":
      return viaAudio(entree as EntreeAudio);
    case "video":
      return { statut: "indisponible", raison: VIDEO_INDISPONIBLE };
    case "agents":
      return { statut: "indisponible", raison: AGENTS_INDISPONIBLE };
    case "automation":
      return { statut: "indisponible", raison: AUTOMATION_INDISPONIBLE };
    case "embeddings":
      return { statut: "indisponible", raison: EMBEDDINGS_INDISPONIBLE };
    case "training":
      return { statut: "indisponible", raison: TRAINING_INDISPONIBLE };
  }
}
