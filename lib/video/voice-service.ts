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
import { addElevenLabsVoice, elevenLabsTextToSpeech } from "@/lib/integrations/elevenlabs/client";
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
 * Profil voix étendu des champs de clonage persistés dans le document
 * videoVoices (typage local : l'interface partagée VoiceProfile reste
 * intacte — le champ est purement additionnel côté Firestore).
 */
type VoiceProfileWithClone = VoiceProfile & {
  /** Date (ms) du clonage ElevenLabs réussi — sert d'idempotence. */
  clonedAtMs?: number;
};

/**
 * Clonages ElevenLabs en cours, par identifiant de profil : dédoublonne les
 * appels concurrents DANS ce processus. L'idempotence inter-processus passe
 * par le document (relecture fraîche de elevenLabsVoiceId avant clonage,
 * puis écriture voiceId + clonedAtMs dès le succès).
 */
const cloningInFlight = new Map<string, Promise<string>>();

/**
 * Renvoie l'identifiant ElevenLabs à utiliser pour la narration :
 * - voix déjà liée (elevenLabsVoiceId) → telle quelle ;
 * - voix « recording » ATTESTÉE (rightsConfirmedAt) sans identifiant → clonage
 *   réel de l'échantillon UNE FOIS via addElevenLabsVoice, puis persistance
 *   du voiceId cloné dans le doc videoVoices (elevenLabsVoiceId + clonedAtMs)
 *   pour ne jamais cloner deux fois ; le commentaire historique « la voix
 *   user_voice est clonée côté ElevenLabs » devient enfin vrai, et le coût
 *   TTS/clonage est assumé puisque l'utilisateur a attesté ses droits ;
 * - voix de bibliothèque/importée sans identifiant → undefined (comportement
 *   existant conservé : repli sur la voix plateforme via resolveVoiceId).
 *   Une voix « recording » non clonable (échantillon absent/hors stockage,
 *   attestation manquante) lève une erreur FR claire : jamais de narration
 *   muette silencieuse ni de voix de remplacement déguisée en voix de
 *   l'utilisateur (le stage voice de la production sait gérer l'échec —
 *   reprise/échec explicite avec message).
 */
async function ensureElevenLabsClonedVoice(
  userId: string,
  voice: VoiceProfile,
): Promise<string | undefined> {
  if (voice.elevenLabsVoiceId) return voice.elevenLabsVoiceId;
  if (voice.origin !== "recording") return undefined;

  if (!voice.rightsConfirmedAt) {
    throw new Error(
      `La voix « ${voice.name} » n'a pas d'attestation de droits : le clonage ElevenLabs exige l'attestation (spéc §10B).`,
    );
  }
  if (!voice.sampleR2Key || !isOwnedVideoKey(userId, voice.sampleR2Key)) {
    throw new Error(
      `L'échantillon de la voix « ${voice.name} » est introuvable : réenregistrez votre voix pour activer le clonage.`,
    );
  }

  // Relecture fraîche : un autre processus (route ou worker) a peut-être
  // déjà cloné cette voix depuis que ce profil a été chargé.
  const snap = await adminDb.collection(VOICES_COLLECTION).doc(voice.id).get();
  const fresh = snap.exists ? (snap.data() as VoiceProfileWithClone) : undefined;
  if (fresh?.elevenLabsVoiceId) return fresh.elevenLabsVoiceId;

  const inFlight = cloningInFlight.get(voice.id);
  if (inFlight) return inFlight;

  const clone = (async (): Promise<string> => {
    // L'échantillon est le WebM/Opus du MediaRecorder navigateur (même
    // hypothèse que attachRecordingAsNarration côté contentType).
    const audio = await downloadVideoAsset(userId, voice.sampleR2Key as string);
    const audioDataUri = `data:audio/webm;base64,${audio.toString("base64")}`;
    let cloned: Awaited<ReturnType<typeof addElevenLabsVoice>>;
    try {
      cloned = await addElevenLabsVoice({
        name: voice.name,
        audioDataUri,
        ...(voice.description ? { description: voice.description } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Le clonage de la voix « ${voice.name} » a échoué : ${message}`);
    }
    // Persistance de l'idempotence : toute narration suivante réutilisera
    // cette voix sans re-cloner (coût clonage payé une seule fois).
    await adminDb
      .collection(VOICES_COLLECTION)
      .doc(voice.id)
      .set(
        { elevenLabsVoiceId: cloned.voiceId, clonedAtMs: Date.now() },
        { merge: true },
      );
    return cloned.voiceId;
  })();

  cloningInFlight.set(voice.id, clone);
  try {
    return await clone;
  } finally {
    cloningInFlight.delete(voice.id);
  }
}

/**
 * Génère la narration d'une scène avec la voix choisie et l'enregistre
 * comme asset audio du projet. La voix « user_voice » est réellement clonée
 * côté ElevenLabs via l'échantillon attesté (clonage une seule fois, voiceId
 * persisté dans le doc videoVoices) ; le bridge remonte les erreurs réelles
 * (clé manquante, échec de clonage, quota ElevenLabs) sans les masquer.
 */
export async function generateSceneNarration(params: {
  userId: string;
  projectId: string;
  sceneId: string;
  narration: string;
  voice: VoiceProfile;
}): Promise<NarrationResult> {
  const voiceId = await ensureElevenLabsClonedVoice(params.userId, params.voice);
  const tts = await elevenLabsTextToSpeech({
    text: params.narration,
    voiceId,
    modelId: "eleven_multilingual_v2",
  });
  const audio = Buffer.from(tts.audioBase64, "base64");
  const asset = await registerAsset({
    userId: params.userId,
    projectId: params.projectId,
    kind: "audio_narration",
    label: `Narration ${params.sceneId}`,
    role: `narration:${params.sceneId}`,
    sceneId: params.sceneId,
    origin: "generated",
    contentType: tts.mimeType || "audio/mpeg",
    body: audio,
  });
  return {
    assetId: asset.id,
    r2Key: asset.r2Key,
    voiceIdUsed: tts.voiceId,
    charactersUsed: tts.charactersUsed,
    durationSec: asset.media?.durationSec,
  };
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
