import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { getMessagingChannelStatus } from "@/lib/integrations/messaging";
import { isEmailProviderConfigured } from "@/lib/integrations/email/send";

/**
 * Statut des canaux natifs de la plateforme (aucun secret exposé) :
 * sert uniquement à l'affichage de la page /integrations.
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  return NextResponse.json(
    {
      messaging: getMessagingChannelStatus(),
      email: isEmailProviderConfigured(),
      composio: Boolean(process.env.COMPOSIO_API_KEY),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
