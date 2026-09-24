import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus, errorCode } from "@/lib/security/http-errors";
import { adminDb } from "@/lib/firebase/admin";

/**
 * Préférences utilisateur (paramètres) — document Firestore `userSettings/{uid}`.
 *
 * GET  /api/settings/preferences → { adsEnabled, ... }
 * POST /api/settings/preferences → { adsEnabled? } (mise à jour partielle)
 *
 * adsEnabled : l'utilisateur contrôle l'affichage des espaces publicitaires
 * de la plateforme (la page Paramètres › Publicité propose l'interrupteur).
 */

export const runtime = "nodejs";

const PreferencesBody = z.object({
  adsEnabled: z.boolean().optional(),
});

const COLLECTION = "userSettings";

async function readPreferences(userId: string): Promise<{ adsEnabled: boolean }> {
  const snapshot = await adminDb.collection(COLLECTION).doc(userId).get();
  const data = snapshot.data();
  // Défaut : les espaces publicitaires sont affichés (opt-out explicite).
  return { adsEnabled: data?.adsEnabled !== false };
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    return NextResponse.json(await readPreferences(user.uid));
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: errorStatus(error), headers: { "x-gen3ia-error-code": errorCode(error) } });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const body = PreferencesBody.parse(await request.json());
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof body.adsEnabled === "boolean") patch.adsEnabled = body.adsEnabled;
    await adminDb.collection(COLLECTION).doc(user.uid).set(patch, { merge: true });
    return NextResponse.json(await readPreferences(user.uid));
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: errorStatus(error), headers: { "x-gen3ia-error-code": errorCode(error) } });
  }
}
