import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DEMANDE PROPRIÉTAIRE (2026-11-11) : « gen3 doit pouvoir générer de vidéo
 * et voix ultra réaliste » — la narration des scènes vidéo est RÉTABLIE sur
 * le moteur voix du professeur (cascade passerelle interne → espace public
 * Edge-TTS), avec la voix choisie selon le PERSONNAGE du brief (« un homme
 * qui dit… » → voix masculine). Verrous :
 *  - voie B : scene.narration réellement synthétisée et enregistrée comme
 *    asset audio_narration (caractères facturés retournés) ;
 *  - genre respecté : « un homme » → voix Edge masculine (Henri) ;
 *  - honnêteté : professeur ABSENT → 0 caractère, scène muette assumée,
 *    AUCUN asset, JAMAIS de faux succès ;
 *  - voie A préservée : un enregistrement utilisateur reste utilisé tel quel.
 */

const mocks = vi.hoisted(() => ({
  professeurVoix: vi.fn(),
  professeurDisponibleAsync: vi.fn(),
  registerAsset: vi.fn(),
  attachRecordingAsNarration: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({ adminDb: { collection: () => ({ doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) }), runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) } }));

vi.mock("@/lib/neural/professeur-media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/neural/professeur-media")>();
  return {
    ...actual,
    professeurVoix: mocks.professeurVoix,
    professeurDisponibleAsync: mocks.professeurDisponibleAsync,
  };
});

vi.mock("@/lib/video/asset-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/video/asset-service")>();
  return {
    ...actual,
    registerAsset: mocks.registerAsset,
  };
});

vi.mock("@/lib/video/voice-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/video/voice-service")>();
  return {
    ...actual,
    attachRecordingAsNarration: mocks.attachRecordingAsNarration,
  };
});

import { narrationTaskForScene } from "@/lib/video/production-stages";
import type { ScriptScene, VideoProductionJob, VoiceProfile } from "@/lib/video/types";

const job = {
  id: "job-1",
  userId: "user-1",
  projectId: "proj-1",
  prompt: "Crée une vidéo : un homme qui mange du poulet frit et dit qu'il a besoin d'une eau pétillante",
  sceneCursor: 0,
} as unknown as VideoProductionJob;

const scene = { id: "scene-1", narration: "Il me faut une eau pétillante pour accompagner ce poulet frit." } as unknown as ScriptScene;
const voixPlateforme = { origin: "platform" } as unknown as VoiceProfile;

const ŒUVRE_MP3 = { buffer: Buffer.alloc(4096, 1), mime: "audio/mpeg", meta: { moteur: "professeur-voix-espace-edge-tts", voix: "fr-FR-HenriNeural - fr-FR (Male)", echafaudage: true } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("narrationTaskForScene — voie B TTS professeur (voix ultra réaliste vidéo)", () => {
  it("synthétise RÉELLEMENT la narration et l'enregistre comme audio_narration (voix selon le personnage)", async () => {
    mocks.professeurDisponibleAsync.mockResolvedValue(true);
    mocks.professeurVoix.mockResolvedValue(ŒUVRE_MP3);
    mocks.registerAsset.mockResolvedValue({ id: "asset-1" });

    const caractères = await narrationTaskForScene(job, scene, voixPlateforme, false);

    expect(caractères).toBe(scene.narration.length);
    expect(mocks.professeurVoix).toHaveBeenCalledTimes(1);
    // « un homme … dit » dans le brief → voix MASCULINE (Henri), jamais l'inverse.
    expect(mocks.professeurVoix.mock.calls[0]?.[0]).toMatchObject({
      texte: scene.narration,
      voix: "fr-FR-HenriNeural - fr-FR (Male)",
    });
    expect(mocks.registerAsset).toHaveBeenCalledTimes(1);
    expect(mocks.registerAsset.mock.calls[0]?.[0]).toMatchObject({
      userId: "user-1",
      projectId: "proj-1",
      kind: "audio_narration",
      sceneId: "scene-1",
      role: "narration:scene-1",
      origin: "generated",
      contentType: "audio/mpeg",
    });
  });

  it("professeur ABSENT → 0 caractère, scène muette assumée, AUCUN asset (jamais de faux succès)", async () => {
    mocks.professeurDisponibleAsync.mockResolvedValue(false);
    const caractères = await narrationTaskForScene(job, scene, voixPlateforme, false);
    expect(caractères).toBe(0);
    expect(mocks.professeurVoix).not.toHaveBeenCalled();
    expect(mocks.registerAsset).not.toHaveBeenCalled();
  });

  it("narration vide → 0 caractère sans appel réseau", async () => {
    mocks.professeurDisponibleAsync.mockResolvedValue(true);
    const scèneMuette = { id: "scene-2", narration: "  " } as unknown as ScriptScene;
    expect(await narrationTaskForScene(job, scèneMuette, voixPlateforme, false)).toBe(0);
    expect(mocks.professeurVoix).not.toHaveBeenCalled();
  });

  it("voie A préservée : un enregistrement utilisateur reste utilisé tel quel (0 facturé)", async () => {
    mocks.attachRecordingAsNarration.mockResolvedValue({ assetId: "asset-a", r2Key: "k" });
    const voixEnregistrée = { origin: "recording", sampleR2Key: "users/user-1/video/proj-1/voice/sample.webm" } as unknown as VoiceProfile;
    const caractères = await narrationTaskForScene(job, scene, voixEnregistrée, false);
    expect(caractères).toBe(0);
    expect(mocks.attachRecordingAsNarration).toHaveBeenCalledTimes(1);
    expect(mocks.professeurVoix).not.toHaveBeenCalled();
  });
});
