import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getAgentForUser } from "@/lib/agents/repository";
import { syncAgentToBland } from "@/lib/voice/bland-agent-sync";
import { isBlandSyncStale } from "@/lib/voice/bland-agent-sync";

export const runtime = "nodejs";
export const maxDuration = 60;

type Context = { params: Promise<{ id: string }> };

/**
 * Synchronisation manuelle agent Gen3ia → agent Bland
 * (POST /api/agents/{id}/voice/sync).
 *
 * Publie la configuration courante (prompt, personnalité, langue, voix)
 * en version staging puis la promeut en production. Utilisée depuis la
 * Call App pour forcer une resynchronisation avant un appel.
 */
export async function POST(request: NextRequest, context: Context) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`voice-agent-sync:${user.uid}`, { limit: 10, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de synchronisations, patientez un instant." }, { status: 429 });

    const { id } = await context.params;
    const agent = await getAgentForUser(user.uid, id);
    if (!agent) return NextResponse.json({ error: "Agent introuvable." }, { status: 404 });
    if (!agent.voiceEnabled) {
      return NextResponse.json({ error: "Activez d'abord la voix sur cet agent (configuration vocale)." }, { status: 400 });
    }

    const result = await syncAgentToBland(user.uid, agent);
    return NextResponse.json({
      blandAgentId: result.blandAgentId,
      semver: result.semver,
      syncedAt: result.syncedAt,
      created: result.created,
    });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Synchronisation Bland impossible."), { status: errorStatus(error) });
  }
}

/** État de synchronisation (GET) — sans effet de bord. */
export async function GET(request: NextRequest, context: Context) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const agent = await getAgentForUser(user.uid, id);
    if (!agent) return NextResponse.json({ error: "Agent introuvable." }, { status: 404 });
    return NextResponse.json({
      voiceEnabled: agent.voiceEnabled,
      blandAgentId: agent.voiceConfig?.blandAgentId ?? null,
      blandSyncedAt: agent.voiceConfig?.blandSyncedAt ?? null,
      blandSemver: agent.voiceConfig?.blandSemver ?? null,
      stale: isBlandSyncStale(agent),
    });
  } catch (error) {
    return NextResponse.json(errorBody(error, "État de synchronisation indisponible."), { status: errorStatus(error) });
  }
}
