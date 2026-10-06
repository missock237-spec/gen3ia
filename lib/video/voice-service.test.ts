import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests du clonage vocal RÉEL (Task 103-b) : la voix « recording » attestée
 * est clonée côté ElevenLabs UNE SEULE FOIS via addElevenLabsVoice, le
 * voiceId cloné (+ clonedAtMs) est persisté dans le doc videoVoices, puis
 * la narration TTS utilise cette voix. Échec de clonage → erreur FR claire
 * remontée (jamais de narration muette silencieuse ni de repli caché).
 *
 * Patterns du dépôt : adminDb factice à état hoisted (comme
 * production-queue-resume.test.ts), intégrations mockées en vi.fn.
 */

// ---------------------------------------------------------------------------
// État hoisted — Firestore factice (docs videoVoices)
// ---------------------------------------------------------------------------

const voiceDocs = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: (id: string) => {
        const docPath = `${name}/${id}`;
        return {
          create: async (payload: Record<string, unknown>) => {
            voiceDocs.set(docPath, { ...payload });
            return {};
          },
          get: async () => {
            const data = voiceDocs.get(docPath);
            return data ? { exists: true, data: () => data } : { exists: false, data: () => undefined };
          },
          set: async (payload: Record<string, unknown>, opts?: { merge?: boolean }) => {
            const existing = voiceDocs.get(docPath);
            voiceDocs.set(docPath, opts?.merge === true ? { ...(existing ?? {}), ...payload } : { ...payload });
            return {};
          },
        };
      },
    }),
  },
}));

vi.mock("@/lib/video/storage", () => ({
  isOwnedVideoKey: (userId: string, key: string) =>
    typeof key === "string" && key.startsWith(`users/${userId}/video/`),
  uploadVideoAsset: vi.fn(),
  downloadVideoAsset: vi.fn(),
}));

vi.mock("@/lib/video/ffmpeg", () => ({
  probeMedia: vi.fn(),
}));

vi.mock("@/lib/video/asset-service", () => ({
  registerAsset: vi.fn(),
}));

vi.mock("@/lib/integrations/elevenlabs/client", () => ({
  addElevenLabsVoice: vi.fn(),
  elevenLabsTextToSpeech: vi.fn(),
}));

// ---------------------------------------------------------------------------

import { generateSceneNarration } from "@/lib/video/voice-service";
import {
  addElevenLabsVoice,
  elevenLabsTextToSpeech,
} from "@/lib/integrations/elevenlabs/client";
import { downloadVideoAsset } from "@/lib/video/storage";
import { registerAsset } from "@/lib/video/asset-service";
import type { VoiceProfile } from "@/lib/video/types";

const mockedClone = vi.mocked(addElevenLabsVoice);
const mockedTts = vi.mocked(elevenLabsTextToSpeech);
const mockedDownload = vi.mocked(downloadVideoAsset);
const mockedRegister = vi.mocked(registerAsset);

function recordingVoice(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    id: "voice-1",
    userId: "user-1",
    name: "Ma voix",
    language: "fr",
    origin: "recording",
    sampleR2Key: "users/user-1/video/voice-library/sample-abc",
    durationSec: 12,
    isDefault: true,
    rightsConfirmedAt: "2025-01-01T00:00:00.000Z",
    status: "active",
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function seedVoiceDoc(voice: VoiceProfile): void {
  voiceDocs.set(`videoVoices/${voice.id}`, { ...voice });
}

beforeEach(() => {
  voiceDocs.clear();
  vi.clearAllMocks();
  seedVoiceDoc(recordingVoice());
  mockedDownload.mockResolvedValue(Buffer.from("faux-webm"));
  mockedRegister.mockResolvedValue({ id: "asset-1", media: { durationSec: 2.5 } } as never);
  mockedTts.mockResolvedValue({
    audioBase64: Buffer.from("mp3-bytes").toString("base64"),
    mimeType: "audio/mpeg",
    voiceId: "clone-1",
    modelId: "eleven_multilingual_v2",
    charactersUsed: 42,
  });
});

describe("generateSceneNarration — clonage réel de la voix enregistrée", () => {
  it("clône l'échantillon attesté, persiste le voiceId (idempotence) puis l'utilise pour la narration", async () => {
    mockedClone.mockResolvedValue({ voiceId: "clone-1" });

    const result = await generateSceneNarration({
      userId: "user-1",
      projectId: "proj-1",
      sceneId: "scene-1",
      narration: "Bonjour le monde",
      voice: recordingVoice(), // PAS d'elevenLabsVoiceId
    });

    // Clonage réel : un seul appel, avec l'échantillon téléchargé du stockage.
    expect(mockedClone).toHaveBeenCalledTimes(1);
    const cloneArgs = mockedClone.mock.calls[0][0];
    expect(cloneArgs.name).toBe("Ma voix");
    expect(cloneArgs.audioDataUri).toMatch(/^data:audio\/webm;base64,/);
    expect(mockedDownload).toHaveBeenCalledWith("user-1", "users/user-1/video/voice-library/sample-abc");

    // Idempotence : voiceId + clonedAtMs persistés dans le doc videoVoices.
    const doc = voiceDocs.get("videoVoices/voice-1") as { elevenLabsVoiceId?: string; clonedAtMs?: number };
    expect(doc.elevenLabsVoiceId).toBe("clone-1");
    expect(typeof doc.clonedAtMs).toBe("number");

    // La narration TTS utilise la voix clonée.
    expect(mockedTts).toHaveBeenCalledWith({
      text: "Bonjour le monde",
      voiceId: "clone-1",
      modelId: "eleven_multilingual_v2",
    });
    expect(result.voiceIdUsed).toBe("clone-1");
    expect(result.assetId).toBe("asset-1");
    expect(result.charactersUsed).toBe(42);

    // Deuxième narration avec le profil ENCORE STALE (sans voiceId) : la
    // relecture fraîche du doc renvoie la voix clonée → JAMAIS deux clones.
    await generateSceneNarration({
      userId: "user-1",
      projectId: "proj-1",
      sceneId: "scene-2",
      narration: "Deuxième scène",
      voice: recordingVoice(),
    });
    expect(mockedClone).toHaveBeenCalledTimes(1); // toujours un seul clonage
    expect(mockedTts).toHaveBeenCalledTimes(2);
    expect(mockedTts.mock.calls[1][0].voiceId).toBe("clone-1");
  });

  it("échec de clonage : erreur FR claire remontée, aucun TTS silencieux, doc non muté", async () => {
    mockedClone.mockRejectedValue(new Error("Le clonage de la voix a échoué (ElevenLabs 402) : quota"));

    await expect(
      generateSceneNarration({
        userId: "user-1",
        projectId: "proj-1",
        sceneId: "scene-1",
        narration: "Bonjour",
        voice: recordingVoice(),
      }),
    ).rejects.toThrow(/Le clonage de la voix « Ma voix » a échoué : .*ElevenLabs 402.*quota/);

    expect(mockedTts).not.toHaveBeenCalled();
    const doc = voiceDocs.get("videoVoices/voice-1") as { elevenLabsVoiceId?: string; clonedAtMs?: number };
    expect(doc.elevenLabsVoiceId).toBeUndefined();
    expect(doc.clonedAtMs).toBeUndefined();
  });

  it("voix déjà liée (elevenLabsVoiceId) : aucun clonage, TTS direct", async () => {
    const linked = recordingVoice({ elevenLabsVoiceId: "eleven-existing" });
    seedVoiceDoc(linked);

    await generateSceneNarration({
      userId: "user-1",
      projectId: "proj-1",
      sceneId: "scene-1",
      narration: "Bonjour",
      voice: linked,
    });

    expect(mockedClone).not.toHaveBeenCalled();
    expect(mockedDownload).not.toHaveBeenCalled();
    expect(mockedTts.mock.calls[0][0].voiceId).toBe("eleven-existing");
  });

  it("voix recording sans échantillon exploitable : erreur FR (pas de repli muet)", async () => {
    await expect(
      generateSceneNarration({
        userId: "user-1",
        projectId: "proj-1",
        sceneId: "scene-1",
        narration: "Bonjour",
        voice: recordingVoice({ sampleR2Key: undefined }),
      }),
    ).rejects.toThrow(/échantillon de la voix « Ma voix » est introuvable/);

    // Échantillon hors du stockage propriétaire : même garde.
    await expect(
      generateSceneNarration({
        userId: "user-1",
        projectId: "proj-1",
        sceneId: "scene-1",
        narration: "Bonjour",
        voice: recordingVoice({ sampleR2Key: "users/autre-user/video/voice-library/sample-xyz" }),
      }),
    ).rejects.toThrow(/échantillon de la voix « Ma voix » est introuvable/);

    expect(mockedClone).not.toHaveBeenCalled();
    expect(mockedTts).not.toHaveBeenCalled();
  });

  it("voix recording sans attestation de droits : erreur FR (condition d'entrée du clonage)", async () => {
    await expect(
      generateSceneNarration({
        userId: "user-1",
        projectId: "proj-1",
        sceneId: "scene-1",
        narration: "Bonjour",
        voice: recordingVoice({ rightsConfirmedAt: undefined }),
      }),
    ).rejects.toThrow(/attestation de droits/);

    expect(mockedClone).not.toHaveBeenCalled();
    expect(mockedTts).not.toHaveBeenCalled();
  });
});
