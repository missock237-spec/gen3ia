import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { getMessagingChannelStatus } from "@/lib/integrations/messaging";
import { isEmailProviderConfigured } from "@/lib/integrations/email/send";

/**
 * Statut de capacité de la plateforme (aucun secret exposé) :
 * sert uniquement à l'affichage des états UI explicites — une
 * fonctionnalité indisponible ne doit jamais être présentée comme
 * immédiatement utilisable (AVAILABLE / CONFIGURATION_REQUIRED / …).
 */

export const runtime = "nodejs";

/** Capacité IA : le moteur NEURONAL Gen3 (interne, 100 % local) —
 * aucune clé externe nécessaire, toujours actif. */
function llmCapability() {
  return {
    configured: true,
    providers: [
      { id: "gen3-snn", configured: true },
    ],
  };
}

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  const searchProvider = (process.env.SEARCH_PROVIDER ?? "").trim().toLowerCase();
  const search = {
    provider: searchProvider || (process.env.SEARCH_API_KEY ? "serpapi" : "none"),
    configured: Boolean(process.env.SEARCH_API_KEY),
  };
  const voice = { elevenlabs: false };
  const composio = Boolean(process.env.COMPOSIO_API_KEY);

  return NextResponse.json(
    {
      messaging: getMessagingChannelStatus(),
      email: isEmailProviderConfigured(),
      composio,
      llm: llmCapability(),
      search,
      voice,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
