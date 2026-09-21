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

/** Capacité LLM : au moins un provider configuré + liste des clés présentes. */
function llmCapability() {
  const providers = [
    { id: "groq", configured: Boolean(process.env.GROQ_API_KEY) },
    { id: "openrouter", configured: Boolean(process.env.OPENROUTER_API_KEY) },
    { id: "openai", configured: Boolean(process.env.OPENAI_API_KEY) },
    { id: "anthropic", configured: Boolean(process.env.ANTHROPIC_API_KEY) },
    { id: "glm", configured: Boolean(process.env.GLM_API_KEY) },
  ];
  return {
    configured: providers.some((provider) => provider.configured),
    providers,
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
  const voice = { elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY) };
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
