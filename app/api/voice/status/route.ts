import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { isBlandConfigured } from "@/lib/integrations/bland/client";
import { listAgentsForUser, toSummary } from "@/lib/agents/repository";
import { isBlandSyncStale } from "@/lib/voice/bland-agent-sync";
import { MAX_DAILY_VOICE_CALLS } from "@/lib/voice/bland-calls";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * État de la plateforme d'appels vocaux (GET /api/voice/status).
 *
 * Renvvoie la disponibilité Bland (clé configurée) et l'état de
 * synchronisation des agents vocaux de l'utilisateur — consommé par la
 * Call App pour afficher les badges « Synchronisé / À synchroniser ».
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const agents = await listAgentsForUser(user.uid);
    const voiceAgents = agents
      .filter((agent) => agent.voiceEnabled && agent.status !== "archived")
      .map((agent) => {
        const summary = toSummary(agent);
        return {
          id: summary.id,
          name: summary.name,
          language: summary.voiceConfig?.language ?? "fr-FR",
          blandAgentId: summary.voiceConfig?.blandAgentId ?? null,
          blandSyncedAt: summary.voiceConfig?.blandSyncedAt ?? null,
          blandSemver: summary.voiceConfig?.blandSemver ?? null,
          stale: isBlandSyncStale(agent),
        };
      });
    return NextResponse.json({
      configured: isBlandConfigured(),
      provider: "bland",
      maxDailyCalls: MAX_DAILY_VOICE_CALLS,
      agents: voiceAgents,
    });
  } catch (error) {
    return NextResponse.json(errorBody(error, "État des appels vocaux indisponible."), { status: errorStatus(error) });
  }
}
