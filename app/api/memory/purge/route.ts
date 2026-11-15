import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { purgeUserData } from "@/lib/memory/privacy";

/**
 * POST /api/memory/purge — effacement RGPD (Task 42, axe 6) : suppression
 * irréversible de toute la mémoire personnalisée du compte (souvenirs,
 * retours IA, leçons, consentements, drapeau de consentement).
 *
 * Double consentement : le corps doit porter `confirm: true` (l'UI demande
 * une confirmation explicite) — sans lui, 428 Precondition Required.
 */

export const runtime = "nodejs";

const PurgeSchema = z.object({ confirm: z.literal(true) });

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request, { key: "memory-purge", rateLimit: { limit: 3, windowMs: 60 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  let confirm = false;
  try {
    confirm = PurgeSchema.parse(await request.json()).confirm;
  } catch {
    confirm = false;
  }
  if (!confirm) {
    return NextResponse.json(
      { error: "Purge non confirmée. Renvoyez { \"confirm\": true } pour confirmer l'effacement irréversible." },
      { status: 428 },
    );
  }
  try {
    const report = await purgeUserData(guard.context.userId);
    return NextResponse.json({ ok: true, ...report }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Purge impossible pour le moment." }, { status: 500 });
  }
}
