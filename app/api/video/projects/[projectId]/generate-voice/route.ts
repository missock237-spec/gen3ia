import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { getOwnedProjectOrThrow, patchProject } from "@/lib/video/project-service";
import { listAssets } from "@/lib/video/asset-service";
import { resolvePreferredVoice, withPlatformVoiceFallback, generateSceneNarration, attachRecordingAsNarration } from "@/lib/video/voice-service";
import { billTts } from "@/lib/video/credits";
import { syncVoiceTrack, applyTimelinePatch } from "@/lib/video/timeline-service";
import { createVideoPlaybackUrl, isOwnedVideoKey } from "@/lib/video/storage";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ projectId: string }> };

const VoiceSchema = z.object({
  /** Scènes à traiter (max 4 par appel — chaînage côté client). */
  sceneIds: z.array(z.string().min(1).max(80)).max(4).optional(),
});

/**
 * Voice Generation Bridge : génère les narrations des scènes avec la voix
 * préférée de l'utilisateur (ElevenLabs ou enregistrement), facture au
 * caractère réel et synchronise la piste VOIX de la timeline.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-generate-voice", rateLimit: { limit: 30, windowMs: 10 * 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const { sceneIds } = VoiceSchema.parse(await request.json().catch(() => ({})));
    const project = await getOwnedProjectOrThrow(guard.context.userId, projectId);
    if (!project.script) throw new Error("Générez d'abord le scénario.");

    // FIX A3 : aucun profil vocal utilisateur n'est plus un échec — la
    // narration retombe sur la VOIX PLATEFORME ElevenLabs (même chemin que
    // la synthèse audio du chat). L'utilisateur peut toujours importer sa
    // propre voix depuis l'onglet Voix pour la surcharger.
    const voice = withPlatformVoiceFallback(await resolvePreferredVoice(guard.context.userId, project));

    const scenes = project.script.scenes.filter((s) => !sceneIds || sceneIds.includes(s.id)).slice(0, 4);
    // Task 113 — le RÉSULTAT est renvoyé à l'utilisateur : chaque narration
    // porte une URL de LECTURE signée (900 s, canal propriétaire) en plus de
    // l'identifiant d'asset — le client peut jouer l'audio immédiatement.
    const generated: Array<{ sceneId: string; assetId: string; audioUrl?: string; durationSec?: number; charactersUsed: number; source: "tts" | "recording" }> = [];

    for (const scene of scenes) {
      // Enregistrement utilisateur : usage direct de l'échantillon (voie A).
      if (voice.origin === "recording" && voice.sampleR2Key && isOwnedVideoKey(guard.context.userId, voice.sampleR2Key)) {
        const result = await attachRecordingAsNarration({
          userId: guard.context.userId,
          projectId,
          sceneId: scene.id,
          sampleR2Key: voice.sampleR2Key,
        });
        generated.push({
          sceneId: scene.id,
          assetId: result.assetId,
          audioUrl: await createVideoPlaybackUrl(guard.context.userId, result.r2Key, 900).catch(() => undefined),
          durationSec: result.durationSec,
          charactersUsed: 0,
          source: "recording",
        });
        continue;
      }
      // Voie B : synthèse ElevenLabs (voix bibliothèque ou clonée confirmée).
      const narration = await generateSceneNarration({
        userId: guard.context.userId,
        projectId,
        sceneId: scene.id,
        narration: scene.narration,
        voice,
      });
      if (narration.charactersUsed > 0) {
        await billTts(guard.context.userId, projectId, narration.charactersUsed);
      }
      generated.push({
        sceneId: scene.id,
        assetId: narration.assetId,
        audioUrl: await createVideoPlaybackUrl(guard.context.userId, narration.r2Key, 900).catch(() => undefined),
        durationSec: narration.durationSec,
        charactersUsed: narration.charactersUsed,
        source: "tts",
      });
    }

    // Synchronisation de la piste VOIX de la timeline.
    if (project.timeline) {
      const narrations = await listAssets(guard.context.userId, projectId, "audio_narration");
      const narrationByScene = new Map(narrations.filter((a) => a.sceneId).map((a) => [a.sceneId!, a]));
      let timeline = syncVoiceTrack(
        project.timeline,
        project.script.scenes
          .filter((s) => narrationByScene.has(s.id))
          .map((s) => ({
            sceneId: s.id,
            assetId: narrationByScene.get(s.id)!.id,
            startSec: s.startSec,
            durationSec: Math.min(s.durationSec, narrationByScene.get(s.id)!.media?.durationSec ?? s.durationSec),
          })),
      );
      // La musique de fond est posée automatiquement si absente.
      if (!timeline.musicBed) {
        const { ensureMusicBed } = await import("@/lib/video/audio-engine");
        const bed = await ensureMusicBed(guard.context.userId, projectId, project.musicMood ?? "documentaire", timeline.durationSec);
        timeline = applyTimelinePatch(timeline, "set_music_bed", undefined, { assetId: bed.id, volume: 0.6, duckTo: 0.22 });
      }
      await patchProject(guard.context.userId, projectId, { timeline });
    }

    return NextResponse.json({ generated, voiceUsed: { id: voice.id, name: voice.name, origin: voice.origin } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Génération de voix impossible" }, { status: errorStatus(error, 500) });
  }
}

/** Bibliothèque d'assets narration du projet (URL de lecture signée incluse). */
export async function GET(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-voice-list", rateLimit: { limit: 120, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const narrations = await listAssets(guard.context.userId, projectId, "audio_narration");
    // Task 113 — le résultat est AUDIBLE : chaque narration porte une URL de
    // lecture signée (900 s) construite depuis sa clé R2 propriétaire.
    const withAudioUrl = await Promise.all(
      narrations.map(async (asset) => ({
        ...asset,
        audioUrl: await createVideoPlaybackUrl(guard.context.userId, asset.r2Key, 900).catch(() => undefined),
      })),
    );
    return NextResponse.json({ narrations: withAudioUrl });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Liste impossible" }, { status: errorStatus(error, 500) });
  }
}

/** Enregistre une narration importée/ajoutée manuellement pour une scène. */
export async function PUT(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-voice-attach", rateLimit: { limit: 20, windowMs: 10 * 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const { sceneId, sampleR2Key } = z.object({ sceneId: z.string().min(1).max(80), sampleR2Key: z.string().min(5).max(400) })
      .parse(await request.json());
    const result = await attachRecordingAsNarration({
      userId: guard.context.userId,
      projectId,
      sceneId,
      sampleR2Key,
    });
    return NextResponse.json({
      ...result,
      audioUrl: await createVideoPlaybackUrl(guard.context.userId, result.r2Key, 900).catch(() => undefined),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Attachement impossible" }, { status: errorStatus(error, 400) });
  }
}
