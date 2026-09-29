import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import {
  getToolConsents,
  setToolConsents,
  CONSENT_CATEGORIES,
  CONSENT_MODES,
  CONSENT_CATEGORY_LABELS,
  type ConsentCategory,
  type ConsentMode,
} from "@/lib/security/tool-consents";

/**
 * GET  /api/settings/tool-consents — consentements de l'utilisateur par
 * catégorie d'outils (Task 42, axe 3).
 * PUT  /api/settings/tool-consents — mise à jour (modes ask | always | deny).
 *
 * Garde : « always » ne pré-approuve JAMAIS les écritures/externes — la
 * validation humaine existante reste la couche finale (voir
 * lib/security/tool-consents.ts, decideConsent).
 */

export const runtime = "nodejs";

const PutSchema = z.object({
  modes: z.record(
    z.enum(CONSENT_CATEGORIES as unknown as [string, ...string[]]),
    z.enum(CONSENT_MODES as unknown as [string, ...string[]]),
  ),
});

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, { key: "tool-consents", rateLimit: { limit: 60, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  const consents = await getToolConsents(guard.context.userId);
  return NextResponse.json(
    {
      consents,
      categories: CONSENT_CATEGORIES.map((category) => ({ id: category, label: CONSENT_CATEGORY_LABELS[category] })),
      modes: CONSENT_MODES,
      defaultMode: "ask",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PUT(request: NextRequest) {
  const guard = await protectRoute(request, { key: "tool-consents", rateLimit: { limit: 30, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const body = PutSchema.parse(await request.json());
    await setToolConsents(guard.context.userId, body.modes as Partial<Record<ConsentCategory, ConsentMode>>);
    const consents = await getToolConsents(guard.context.userId);
    return NextResponse.json({ ok: true, consents }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Consentements invalides." }, { status: 400 });
  }
}
