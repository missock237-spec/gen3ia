import { NextRequest, NextResponse } from "next/server";
import { getAgentById } from "@/lib/agents/repository";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { errorStatus } from "@/lib/security/http-errors";

export const runtime = "nodejs";

type Context = { params: Promise<{ agentId: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const { agentId } = await context.params;
  try {
    const agent = await getAgentById(agentId);
    if (!agent) return NextResponse.json({ error: "Agent introuvable." }, { status: 404 });
    return NextResponse.json({ name: agent.name, description: agent.description });
  } catch (error) {
    console.error("[public-agent] Firebase lookup failed", error);
    return NextResponse.json({ error: "Le chat client est temporairement indisponible. La configuration Firebase doit être activée en production." }, { status: 503 });
  }
}

export async function POST(request: NextRequest, context: Context) {
  const { agentId } = await context.params;
  let agent: Awaited<ReturnType<typeof getAgentById>>;
  try {
    agent = await getAgentById(agentId);
  } catch (error) {
    console.error("[public-agent] Firebase lookup failed", error);
    return NextResponse.json({ error: "Le chat client est temporairement indisponible. La configuration Firebase doit être activée en production." }, { status: 503 });
  }
  if (!agent) return NextResponse.json({ error: "Agent introuvable." }, { status: 404 });
  const body = (await request.json()) as { message?: string };
  const message = body.message?.trim();
  if (!message || message.length > 4000) return NextResponse.json({ error: "Message invalide." }, { status: 400 });
  try {
    const { planUniversalAgent } = await import("@/lib/agents/runtime/unified-agent");
    const { AgentRuntime } = await import("@/lib/agents/runtime/runner");
    const { DEFAULT_EXECUTION_POLICY } = await import("@/lib/security/execution-policy");
    const plan = await planUniversalAgent(agent.ownerId, `${agent.systemPrompt}\n\nRéponds au client de façon claire et commerciale.\nMessage client: ${message}`);
    const result = await new AgentRuntime({ userId: agent.ownerId, objective: message, plan, policy: { ...DEFAULT_EXECUTION_POLICY, allowFileDelete: false, allowExternalApps: false } }).run();
    const outputs = Object.values(result.outputs ?? {}).reverse();
    const text = outputs.find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "Merci pour votre message. Je reviens vers vous rapidement.";
    return NextResponse.json({ text });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Réponse indisponible." }, { status: errorStatus(error, 500) });
  }
}
