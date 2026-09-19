import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { deleteAgentForOwner, getAgentForOwner, toSummary, updateAgentForOwner } from "@/lib/agents/repository";
import { AGENT_TYPES } from "@/lib/agents/schema";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PatchSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  type: z.enum(AGENT_TYPES).optional(),
  systemPrompt: z.string().trim().min(10).max(20_000).optional(),
  modelStrategy: z.enum(["automatic", "fixed"]).optional(),
  preferredProvider: z.string().trim().max(60).optional(),
  preferredModel: z.string().trim().max(160).optional(),
  autonomous: z.boolean().optional(),
  maxIterations: z.number().int().min(1).max(20).optional(),
  tools: z.array(z.string().trim().max(80)).max(30).optional(),
  memoryEnabled: z.boolean().optional(),
  webResearchEnabled: z.boolean().optional(),
  documentGenerationEnabled: z.boolean().optional(),
  voiceEnabled: z.boolean().optional(),
  voiceConfig: z.object({
    language: z.enum(["fr-FR", "en-US", "en-GB", "es-ES", "de-DE"]).optional(),
    greeting: z.string().trim().min(2).max(800).optional(),
    maxTurns: z.number().int().min(1).max(40).optional(),
    maxDurationSeconds: z.number().int().min(30).max(1800).optional(),
    inboundEnabled: z.boolean().optional(),
    outboundEnabled: z.boolean().optional(),
    voiceEnabled: z.boolean().optional(),
  }).optional(),
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
});

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const record = await getAgentForOwner(user.uid, id);
    if (!record) return NextResponse.json({ error: "Agent introuvable", requestId }, { status: 404 });
    return NextResponse.json(
      { agent: { ...toSummary(record), systemPrompt: record.systemPrompt }, requestId },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent indisponible", requestId },
      { status: 500, headers: { "x-request-id": requestId } },
    );
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const parsed = PatchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Mise a jour invalide", issues: parsed.error.flatten(), requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }
    const record = await updateAgentForOwner(user.uid, id, parsed.data);
    if (!record) return NextResponse.json({ error: "Agent introuvable", requestId }, { status: 404 });
    return NextResponse.json({ agent: toSummary(record), requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Mise a jour impossible", requestId },
      { status: 500, headers: { "x-request-id": requestId } },
    );
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const deleted = await deleteAgentForOwner(user.uid, id);
    if (!deleted) return NextResponse.json({ error: "Agent introuvable", requestId }, { status: 404 });
    return NextResponse.json({ deleted: true, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Suppression impossible", requestId },
      { status: 500, headers: { "x-request-id": requestId } },
    );
  }
}
