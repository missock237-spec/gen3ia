import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { getAgentById } from "@/lib/agents/repository";
import {
  appendClientExchange,
  buildCommercialSystemPrompt,
  getCommercialConfigBySlug,
} from "@/lib/agents/commercial";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { clientIp } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

type Context = { params: Promise<{ slug: string }> };

/**
 * Chat CLIENT public d'un agent commercial (lien /client/c/<slug>).
 *
 * Sans compte, sans session : les clients de l'utilisateur conversent avec
 * l'agent, nourri par la fiche entreprise complète (prompt commercial).
 * Les conversations sont persistées (transcript + lead) et facturées au
 * PROPRIÉTAIRE de l'agent.
 *
 * Anti-abus dur : rate limit DISTRIBUÉ (Redis) par IP + slug — le lien est
 * public, l'exécution d'agent coûte de l'argent au propriétaire ; sans
 * quota partagé, un attaquant pourrait vider son wallet.
 */
export async function GET(_request: NextRequest, context: Context) {
  const { slug } = await context.params;
  try {
    const config = await getCommercialConfigBySlug(slug);
    if (!config) return NextResponse.json({ error: "Ce lien client est invalide ou désactivé." }, { status: 404 });
    let agentName = "Assistant";
    try {
      const agent = await getAgentById(config.agentId);
      if (agent) agentName = agent.name;
    } catch { /* nom générique si Firebase indisponible */ }
    return NextResponse.json({
      companyName: config.companyName,
      agentName,
      welcomeMessage: config.welcomeMessage ?? "Bonjour ! Comment pouvons-nous vous aider aujourd'hui ?",
      language: config.language,
    });
  } catch {
    return NextResponse.json({ error: "Salon client temporairement indisponible." }, { status: 503 });
  }
}

export async function POST(request: NextRequest, context: Context) {
  const { slug } = await context.params;
  try {
    const config = await getCommercialConfigBySlug(slug);
    if (!config) return NextResponse.json({ error: "Ce lien client est invalide ou désactivé." }, { status: 404 });

    // Quota distribué : 12 messages / 5 min / (IP, salon) — protège le
    // wallet du propriétaire tout en restant confortable pour un vrai client.
    const ip = clientIp(request);
    const quota = await rateLimitDistributed(`commercial-client:${slug}:${ip}`, { limit: 12, windowMs: 5 * 60 * 1000 });
    if (!quota.allowed) {
      return NextResponse.json(
        { error: "Trop de messages envoyés. Merci de patienter quelques minutes." },
        { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(quota.retryAfterMs / 1000))) } },
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      message?: string;
      conversationId?: string;
      clientName?: string;
      clientContact?: string;
    };
    const message = typeof body.message === "string" ? body.message.trim().slice(0, 2_000) : "";
    if (!message) return NextResponse.json({ error: "Message invalide." }, { status: 400 });
    const conversationId = typeof body.conversationId === "string" && body.conversationId.length <= 128 ? body.conversationId : randomUUID();

    const agent = await getAgentById(config.agentId);
    if (!agent) return NextResponse.json({ error: "Agent commercial indisponible." }, { status: 503 });

    const systemPrompt = buildCommercialSystemPrompt(config);
    const clientName = typeof body.clientName === "string" ? body.clientName.trim().slice(0, 120) : undefined;
    const clientContact = typeof body.clientContact === "string" ? body.clientContact.trim().slice(0, 160) : undefined;

    try {
      const { planUniversalAgent } = await import("@/lib/agents/runtime/unified-agent");
      const { AgentRuntime } = await import("@/lib/agents/runtime/runner");
      const { DEFAULT_EXECUTION_POLICY } = await import("@/lib/security/execution-policy");

      const objective = `${systemPrompt}\n\n--- MESSAGE DU CLIENT ---\n${message}`;
      const plan = await planUniversalAgent(config.ownerId, objective, {
        agent: {
          // Charte = fiche entreprise complète ; outils limités aux lectures
          // sûres : un salon client ne doit ni écrire des fichiers ni
          // déclencher d'actions externes au nom de l'entreprise.
          charter: systemPrompt,
          allowedTools: ["web.search", "web.open", "knowledge.search", "memory.read"],
        },
      });
      const result = await new AgentRuntime({
        userId: config.ownerId,
        objective: message,
        plan,
        policy: { ...DEFAULT_EXECUTION_POLICY, allowFileDelete: false, allowExternalApps: false },
      }).run();
      const outputs = Object.values(result.outputs ?? {}).reverse();
      const text = outputs.find((value): value is string => typeof value === "string" && value.trim().length > 0)
        ?? "Merci pour votre message. Un conseiller reviendra vers vous rapidement.";

      // Transcript + lead (fire-and-forget safe : l'échec ne casse pas la
      // réponse client, mais on attend pour garder la réponse sémantique).
      try {
        await appendClientExchange({
          config,
          conversationId,
          clientMessage: message,
          assistantReply: text,
          clientName,
          clientContact,
        });
      } catch { /* transcript best-effort */ }

      return NextResponse.json({ text, conversationId });
    } catch (error) {
      // Wallet vide / panne LLM : message honnête côté client.
      console.error("[commercial-client] generation failed", error instanceof Error ? error.message : error);
      return NextResponse.json(
        { error: "L'assistant n'a pas pu répondre. Merci de réessayer dans un instant." },
        { status: 503 },
      );
    }
  } catch {
    return NextResponse.json({ error: "Salon client temporairement indisponible." }, { status: 503 });
  }
}
