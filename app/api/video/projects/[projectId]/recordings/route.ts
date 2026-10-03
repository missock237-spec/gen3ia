import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { saveVoiceRecording, listVoiceProfiles, deleteVoiceProfile } from "@/lib/video/voice-service";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ projectId: string }> };

/**
 * Voice Recording (module 7) : le navigateur (téléphone/ordinateur)
 * enregistre via MediaRecorder puis envoie le blob ici — l'échantillon est
 * sondé, stocké dans R2 et la voix créée dans la bibliothèque utilisateur.
 * Attestation de droits OBLIGATOIRE (spec §10B).
 */
export async function POST(request: NextRequest, { params }: Params) {
  const guard = await protectRoute(request, { key: "video-recordings-create", rateLimit: { limit: 12, windowMs: 10 * 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { projectId } = await params;
    const form = await request.formData();
    const blob = form.get("audio");
    const metaRaw = form.get("meta");
    if (!(blob instanceof Blob)) throw new Error("Fichier audio manquant (champ « audio »).");
    if (typeof metaRaw !== "string") throw new Error("Métadonnées manquantes (champ « meta » JSON).");
    const body = Buffer.from(await blob.arrayBuffer());
    const voice = await saveVoiceRecording({
      userId: guard.context.userId,
      body,
      raw: { ...(JSON.parse(metaRaw) as Record<string, unknown>), projectId },
    });
    return NextResponse.json({ voice }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Enregistrement impossible" }, { status: errorStatus(error, 400) });
  }
}

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, { key: "video-recordings-list", rateLimit: { limit: 60, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const voices = await listVoiceProfiles(guard.context.userId);
    return NextResponse.json({ voices });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Liste impossible" }, { status: errorStatus(error, 500) });
  }
}

export async function DELETE(request: NextRequest) {
  const guard = await protectRoute(request, { key: "video-recordings-delete", rateLimit: { limit: 12, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;
  try {
    const { voiceId } = (await request.json()) as { voiceId?: string };
    if (!voiceId) throw new Error("voiceId requis.");
    await deleteVoiceProfile(guard.context.userId, voiceId);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Suppression impossible" }, { status: errorStatus(error, 400) });
  }
}
