import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getAgentForUser } from "@/lib/agents/repository";
import { getWallet } from "@/lib/billing/wallet";
import { BILLING_ENABLED } from "@/lib/billing/billing-mode";
import { isBlandConfigured, sendBlandCall } from "@/lib/integrations/bland/client";
import { ensureAgentSynced, mapGen3iaLanguageToBland } from "@/lib/voice/bland-agent-sync";
import {
  VOICE_CALL_MIN_BALANCE_MINOR,
  createVoiceCallRecord,
  listVoiceCalls,
  reserveDailyVoiceCallSlot,
} from "@/lib/voice/bland-calls";
import { logger } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const maxDuration = 60;

/** URL publique que Bland appelle à la fin de l'appel (webhook post-appel). */
function blandWebhookUrl(): string | undefined {
  const base = process.env.BLAND_WEBHOOK_BASE_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!base) {
    logger.warn({ hint: "BLAND_WEBHOOK_BASE_URL / NEXT_PUBLIC_APP_URL" }, "bland_webhook_base_url_missing");
    return undefined;
  }
  return `${base.replace(/\/+$/, "")}/api/voice/webhook/bland`;
}

/**
 * Call App — API centrale des appels vocaux IA (Bland AI).
 *
 * GET  : historique des appels de l'utilisateur (filtre agentId optionnel).
 * POST : lance un appel sortant avec l'agent vocal choisi. L'agent Gen3ia
 *        est d'abord synchronisé vers son agent Bland (création ou mise à
 *        jour si la config a changé), puis l'appel part en mode agent_id —
 *        l'agent Bland exécute sa version production.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`voice-calls-list:${user.uid}`, { limit: 120, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes." }, { status: 429 });
    const agentId = request.nextUrl.searchParams.get("agentId") ?? undefined;
    const calls = await listVoiceCalls(user.uid, agentId, 40);
    return NextResponse.json({ calls, configured: isBlandConfigured() });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Historique d'appels indisponible."), { status: errorStatus(error) });
  }
}

const CallSchema = z.object({
  agentId: z.string().min(1).max(128),
  to: z.string().regex(/^\+[1-9]\d{7,14}$/, "Numéro au format +E164 requis."),
  objective: z.string().trim().min(3).max(4_000).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`voice-call:${user.uid}`, { limit: 10, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Limite d'appels vocaux atteinte pour cette heure." }, { status: 429 });

    const parsed = CallSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Paramètres d'appel invalides (numéro au format +E164, agent requis)." }, { status: 400 });
    }

    const agent = await getAgentForUser(user.uid, parsed.data.agentId);
    if (!agent) return NextResponse.json({ error: "Agent introuvable." }, { status: 404 });
    if (!agent.voiceEnabled || agent.voiceConfig?.outboundEnabled === false) {
      return NextResponse.json({ error: "Les appels sortants sont désactivés pour cet agent." }, { status: 400 });
    }

    const config = agent.voiceConfig;
    const objective =
      parsed.data.objective?.trim() ||
      agent.description?.trim() ||
      "Assister le correspondant dans le périmètre de cet agent.";

    // Garde de trésorerie AVANT toute dépense : le wallet doit dépasser le
    // plancher (l'appel sera ensuite facturé à la minute via le webhook).
    // Mode libre : garde neutralisée — aucun appel ne doit être bloqué par
    // un solde (BILLING_ENABLED=false → jamais de 402 sur cette surface).
    let walletSufficient = true;
    if (BILLING_ENABLED) {
      try {
        const wallet = await getWallet(user.uid);
        walletSufficient = wallet.availableMinor >= VOICE_CALL_MIN_BALANCE_MINOR;
      } catch (walletError) {
        // Fail-open sur l'indisponibilité du wallet (l'appel reste facturable
        // via billUsage à la complétion) : on journalise l'incident.
        logger.warn({ err: walletError }, "voice_call_wallet_check_failed");
      }
    }
    if (!walletSufficient) {
      return NextResponse.json(
        {
          error: `Solde insuffisant pour lancer un appel vocal (minimum requis : ${(VOICE_CALL_MIN_BALANCE_MINOR / 100).toFixed(2)} €). Rechargez votre portefeuille Gen3ia.`,
        },
        { status: 402 },
      );
    }

    // Synchronisation agent Gen3ia ⇄ agent Bland (création si première
    // fois, republication si la configuration a changé depuis la dernière
    // synchro) — condition du « bon fonctionnement » de l'appel.
    const sync = await ensureAgentSynced(user.uid, agent);

    // Quota journalier (transaction atomique — échoue si dépassé).
    await reserveDailyVoiceCallSlot(user.uid);

    const call = await sendBlandCall({
      phoneNumber: parsed.data.to,
      agentId: sync.blandAgentId,
      firstSentence: config?.greeting,
      language: mapGen3iaLanguageToBland(config?.language),
      maxDurationMinutes: Math.max(1, Math.ceil((config?.maxDurationSeconds ?? 300) / 60)),
      record: true,
      webhook: blandWebhookUrl(),
      webhookEvents: ["call"],
      metadata: { userId: user.uid, agentId: agent.id, origin: "gen3ia" },
      requestData: { objective },
    });

    const record = await createVoiceCallRecord({
      callId: call.callId,
      userId: user.uid,
      agentId: agent.id,
      agentName: agent.name,
      blandAgentId: sync.blandAgentId,
      to: parsed.data.to,
      objective,
      language: config?.language ?? "fr-FR",
    });

    return NextResponse.json({
      sessionId: record.id,
      callId: record.id,
      status: "queued",
      to: record.to,
      provider: "bland",
      blandAgentId: sync.blandAgentId,
      semver: sync.semver,
    });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Appel impossible."), { status: errorStatus(error) });
  }
}
