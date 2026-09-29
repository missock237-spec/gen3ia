import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { getMemoryConsent, setMemoryConsent } from "@/lib/memory/privacy";

/**
 * GET  /api/memory/consent — état du consentement de traitement mémoire
 *      (défaut : consenti — comportement historique).
 * POST /api/memory/consent — accorde ou retire le consentement. Le retrait
 *      est immédiat : les surfaces de lecture mémoire doivent respecter ce
 *      drapeau (les données existantes ne sont PAS supprimées — utiliser
 *      POST /api/memory/purge pour l'effacement).
 */

export const runtime = "nodejs";

const ConsentSchema = z.object({ memoryProcessing: z.boolean() });

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, { key: "memory-consent", rateLimit: { limit: 60, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  const state = await getMemoryConsent(guard.context.userId);
  return NextResponse.json(state, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request, { key: "memory-consent", rateLimit: { limit: 20, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const body = ConsentSchema.parse(await request.json());
    const state = await setMemoryConsent(guard.context.userId, body.memoryProcessing);
    return NextResponse.json(state, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Corps de consentement invalide." }, { status: 400 });
  }
}
