import "server-only";

/**
 * GEN3IA VIDEO AGENT — module 6 : Voice Generation Bridge (ElevenLabs
 * existant) + module 7 : Voice Recording + module 9 : Voice Library.
 *
 * Deux voies pour la voix (spec §10) :
 * A. Utiliser directement un enregistrement de l'utilisateur (découpage,
 *    nettoyage, synchronisation — côté planner de rendu).
 * B. Recréer la narration avec ElevenLabs à partir d'une voix de la
 *    bibliothèque (échantillon utilisateur avec droits confirmés, ou voix
 *    de la plateforme).
 *
 * La bibliothèque conserve plusieurs voix par utilisateur (principale,
 * documentaire, énergique…) avec nom, langue, description, durée, statut,
 * voix par défaut et attestation de droits obligatoire (spec §9-§10B).
 */

import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { z } from "zod";
import type { VoiceProfile } from "@/lib/video/types";
import { uploadVideoAsset, downloadVideoAsset, isOwnedVideoKey } from "@/lib/video/storage";
import { probeMedia } from "@/lib/video/ffmpeg";
import { registerAsset } from "@/lib/video/asset-service";
import { VoiceCreateSchema, assertMediaTypeAllowed, assertMediaSizeAllowed } from "@/lib/video/security";

export const VOICES_COLLECTION = "videoVoices";

function nowIso(): string {
  return new Date().toISOString();
}

// ────────────────────────────────────────────────────────────────────────────
// Voice Library (module 9)
// ────────────────────────────────────────────────────────────────────────────

export async function createVoiceProfile(userId: string, raw: unknown): Promise<VoiceProfile> {
  const input = VoiceCreateSchema.parse(raw);
  if (input.origin === "recording" && !input.rightsConfirmed) {
    throw new Error("Vous devez confirmer détenir les droits sur cette voix avant de l'enregistrer.");
  }
  if (input.origin === "elevenlabs" && !input.elevenLabsVoiceId) {
    throw new Error("Une voix ElevenLabs requiert l'identifiant de la voix.");
  }
  if (input.origin === "recording" && (!input.sampleR2Key || !isOwnedVideoKey(userId, input.sampleR2Key))) {
    throw new Error("Échantillon de voix manquant ou hors de votre stockage.");
  }

  // Une seule voix par défaut : la nouvelle défaut démote les autres.
  if (input.isDefault) await demoteDefaults(userId);

  const voice: VoiceProfile = {
    id: randomUUID(),
    userId,
    name: input.name,
    language: input.language,
    description: input.description,
    origin: input.origin,
    sampleR2Key: input.sampleR2Key,
    elevenLabsVoiceId: input.elevenLabsVoiceId,
    durationSec: input.durationSec,
    isDefault: input.isDefault,
    rightsConfirmedAt: input.rightsConfirmed ? nowIso() : undefined,
    status: "active",
    createdAt: nowIso(),
  };
  await adminDb.collection(VOICES_COLLECTION).doc(voice.id).create({ ...voice });
  return voice;
}

async function demoteDefaults(userId: string): Promise<void> {
  const snap = await adminDb.collection(VOICES_COLLECTION).where("userId", "==", userId).get();
  const batch = adminDb.batch();
  snap.docs.forEach((doc) => {
    if (doc.data()?.isDefault) batch.set(doc.ref, { isDefault: false }, { merge: true });
  });
  await batch.commit();
}

export async function listVoiceProfiles(userId: string): Promise<VoiceProfile[]> {
  const snap = await adminDb.collection(VOICES_COLLECTION).where("userId", "==", userId).get();
  const voices = snap.docs.map((d) => d.data() as VoiceProfile).filter((v) => v.status !== "deleted");
  voices.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
  return voices;
}

export async function getVoiceProfile(userId: string, voiceId: string): Promise<VoiceProfile | null> {
  const snap = await adminDb.collection(VOICES_COLLECTION).doc(voiceId).get();
  if (!snap.exists) return null;
  const voice = snap.data() as VoiceProfile;
  return voice.userId === userId && voice.status === "active" ? voice : null;
}

export async function resolvePreferredVoice(userId: string, project: { voicePreference: { kind: string; voiceId?: string } }): Promise<VoiceProfile | null> {
  if (project.voicePreference.kind === "user_voice" && project.voicePreference.voiceId) {
    return getVoiceProfile(userId, project.voicePreference.voiceId);
  }
  const voices = await listVoiceProfiles(userId);
  return voices.find((v) => v.isDefault) ?? voices[0] ?? null;
}

/**
 * FIX A3 (rapport de tests 2026-10) — VOIX PLATEFORME PAR DÉFAUT : la
 * narration exigeait un profil vocal utilisateur (enregistrement ou voix
 * ElevenLabs importée) ; un compte sans profil recevait un 500 « Aucune
 * voix disponible » sur generate-voice et une vidéo MUETTE en production
 * autopilote, alors même que le pont ElevenLabs sait retomber sur une voix
 * de plateforme (resolveVoiceId : ELEVENLABS_VOICE_ID → bibliothèque du
 * compte → voix par défaut) — le même chemin que la synthèse audio du chat,
 * qui fonctionne hors de la boîte.
 *
 * Ce profil synthétique n'est PAS persisté (aucun document videoVoices) : il
 * porte origin "elevenlabs" SANS identifiant — ensureElevenLabsClonedVoice
 * retourne undefined et elevenLabsTextToSpeech résout la voix réelle via
 * son repli interne. L'utilisateur peut toujours surcharger en important sa
 * propre voix (le profil réel, lui, reste premier dans la résolution).
 */
export const PLATFORM_VOICE_PROFILE: VoiceProfile = {
  id: "platform-default",
  userId: "*",
  name: "Voix plateforme (par défaut)",
  language: "fr",
  description: "Voix de repli plateforme — la narration TTS externe a été retirée du projet : seule la voie enregistrement utilisateur produit une narration.",
  origin: "elevenlabs",
  sampleR2Key: undefined,
  elevenLabsVoiceId: undefined,
  durationSec: undefined,
  isDefault: false,
  rightsConfirmedAt: undefined,
  status: "active",
  createdAt: "1970-01-01T00:00:00.000Z",
};

/**
 * Résolution de la voix de narration AVEC REPLI PLATEFORME : profil
 * utilisateur (préféré) sinon voix plateforme par défaut — la narration ne
 * peut plus échouer (ni renvoyer 500) faute de profil vocal configuré.
 */
export function withPlatformVoiceFallback(voice: VoiceProfile | null): VoiceProfile {
  return voice ?? PLATFORM_VOICE_PROFILE;
}

export async function deleteVoiceProfile(userId: string, voiceId: string): Promise<void> {
  const voice = await getVoiceProfile(userId, voiceId);
  if (!voice) throw new Error("Voix introuvable.");
  await adminDb.collection(VOICES_COLLECTION).doc(voiceId).set({ status: "deleted", isDefault: false }, { merge: true });
}

// ────────────────────────────────────────────────────────────────────────────
// Voice Recording (module 7) — upload des enregistrements navigateur
// (MediaRecorder → WebM/Opus → canal R2 multipart présigné → profil voix)
// ────────────────────────────────────────────────────────────────────────────

const RecordingBlobSchema = z.object({
  projectId: z.string().min(1).optional(),
  name: z.string().min(1).max(120),
  language: z.string().min(2).max(10).default("fr"),
  description: z.string().max(500).optional(),
  contentType: z.string().min(3).max(120),
  isDefault: z.boolean().default(false),
  rightsConfirmed: z.boolean(),
});

/**
 * Enregistre un échantillon vocal capté dans le navigateur (téléphone,
 * ordinateur, navigateur — spec §8). Le blob arrive par le canal R2
 * multipart présigné (bypass limite de corps serverless) ; ici on reçoit
 * le contenu final et on crée la voix associée.
 */
export async function saveVoiceRecording(params: {
  userId: string;
  body: Buffer;
  raw: unknown;
}): Promise<VoiceProfile> {
  const input = RecordingBlobSchema.parse(params.raw);
  assertMediaTypeAllowed("audio", input.contentType);
  assertMediaSizeAllowed(params.body.byteLength, "audio");
  if (!input.rightsConfirmed) {
    throw new Error("Confirmez que vous détenez les droits sur cette voix.");
  }

  // Sonde réelle : durée de l'enregistrement.
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "gen3ia-voice-"));
  let durationSec: number | undefined;
  try {
    const ext = input.contentType.includes("wav") ? ".wav" : input.contentType.includes("mpeg") ? ".mp3" : ".webm";
    const path = join(dir, `voice${ext}`);
    await writeFile(path, params.body);
    const probe = await probeMedia(path, dir);
    durationSec = probe.durationSec;
  } catch {
    durationSec = undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // Échantillon conservé sous voice/ du projet (ou d'un projet de rangement).
  const projectId = input.projectId ?? "voice-library";
  const { r2Key } = await uploadVideoAsset({
    userId: params.userId,
    projectId,
    domain: "voice",
    body: params.body,
    contentType: input.contentType,
    fileName: `sample-${randomUUID()}`,
  });

  return createVoiceProfile(params.userId, {
    name: input.name,
    language: input.language,
    description: input.description,
    origin: "recording",
    sampleR2Key: r2Key,
    durationSec,
    isDefault: input.isDefault,
    rightsConfirmed: input.rightsConfirmed,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Voice Generation Bridge (module 6) — narration ElevenLabs scène par scène
// ────────────────────────────────────────────────────────────────────────────

export interface NarrationResult {
  assetId: string;
  /**
   * Task 113 — clé R2 de l'audio (canal vidéo propriétaire) : permet aux
   * appelants (route generate-voice) de signer une URL de LECTURE et de
   * renvoyer le RÉSULTAT audible à l'utilisateur, pas seulement un identifiant.
   */
  r2Key: string;
  voiceIdUsed: string;
  charactersUsed: number;
  durationSec?: number;
}


/**
 * NARRATION TTS SUPPRIMÉE — la synthèse vocale externe (ElevenLabs) a été
 * retirée du projet sur demande de l'utilisateur (seules des IA externes
 * devaient disparaître). La narration d'une scène repose EXCLUSIVEMENT sur
 * la voie A : l'enregistrement de la voix de l'utilisateur
 * (attachRecordingAsNarration). Cette fonction existe pour produire une
 * erreur honnête et française si un chemin historique l'appelle encore.
 */
export async function generateSceneNarration(_params: {
  userId: string;
  projectId: string;
  sceneId: string;
  narration: string;
  voice: VoiceProfile;
}): Promise<NarrationResult> {
  throw new Error(
    "Narration TTS indisponible : la synthèse vocale externe a été retirée du projet. Utilisez un enregistrement de votre voix (voie « ma voix ») pour narrer cette scène."
  );
}

/**
 * Voie A (spec §10A) : utilise DIRECTEMENT un enregistrement de
 * l'utilisateur comme narration d'une scène (découpage/nettoyage/
 * synchronisation gérés au montage). Enregistre une copie projet de
 * l'échantillon choisi et la rattache à la scène.
 */
export async function attachRecordingAsNarration(params: {
  userId: string;
  projectId: string;
  sceneId: string;
  sampleR2Key: string;
}): Promise<NarrationResult> {
  if (!isOwnedVideoKey(params.userId, params.sampleR2Key)) {
    throw new Error("Échantillon hors de votre stockage.");
  }
  const audio = await downloadVideoAsset(params.userId, params.sampleR2Key);
  const asset = await registerAsset({
    userId: params.userId,
    projectId: params.projectId,
    kind: "audio_narration",
    label: `Narration (ma voix) ${params.sceneId}`,
    role: `narration:${params.sceneId}`,
    sceneId: params.sceneId,
    origin: "recording",
    contentType: "audio/webm",
    body: audio,
  });
  return { assetId: asset.id, r2Key: asset.r2Key, voiceIdUsed: "user_recording", charactersUsed: 0, durationSec: asset.media?.durationSec };
}
