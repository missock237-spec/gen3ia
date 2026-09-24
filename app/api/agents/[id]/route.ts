import { NextRequest, NextResponse } from "next/server";
import { errorStatus } from "@/lib/security/http-errors";
import { randomUUID } from "crypto";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { deleteAgentForOwner, getAgentForOwner, toSummary, updateAgentForOwner } from "@/lib/agents/repository";
import { AGENT_TYPES } from "@/lib/agents/schema";
import { getDeveloperProject } from "@/lib/developer/projects";

interface RouteContext { params: Promise<{ id: string }> }

const PatchSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(), description: z.string().trim().max(500).optional(),
  type: z.enum(AGENT_TYPES).optional(), projectId: z.string().trim().min(1).max(128).optional(),
  typeLabel: z.string().trim().min(1).max(80).optional(),
  skills: z.array(z.string().trim().min(1).max(80)).max(24).optional(),
  agentMode: z.enum(["standard", "call"]).optional(),
  memoryFile: z.object({ path: z.string().trim().min(1).max(500), name: z.string().trim().min(1).max(255) }).optional(),
  systemPrompt: z.string().trim().min(10).max(20_000).optional(), modelStrategy: z.enum(["automatic", "fixed"]).optional(),
  preferredProvider: z.string().trim().max(60).optional(), preferredModel: z.string().trim().max(160).optional(),
  autonomous: z.boolean().optional(), maxIterations: z.number().int().min(1).max(20).optional(),
  tools: z.array(z.string().trim().max(160)).max(50).optional(), memoryEnabled: z.boolean().optional(),
  webResearchEnabled: z.boolean().optional(), documentGenerationEnabled: z.boolean().optional(), voiceEnabled: z.boolean().optional(),
  voiceConfig: z.object({
    language: z.enum(["fr-FR", "en-US", "en-GB", "es-ES", "de-DE"]).optional(), greeting: z.string().trim().min(2).max(800).optional(),
    maxTurns: z.number().int().min(1).max(40).optional(), maxDurationSeconds: z.number().int().min(30).max(1800).optional(),
    inboundEnabled: z.boolean().optional(), outboundEnabled: z.boolean().optional(), voiceEnabled: z.boolean().optional(),
  }).optional(),
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  authorizationMode: z.enum(["always_ask", "ask_if_needed", "auto_allow"]).optional(),
  budgetEurMinor: z.number().int().min(0).max(1_000_000).optional(),
  subAgentIds: z.array(z.string().trim().min(1).max(128)).max(5).optional(),
  mcpEnabled: z.boolean().optional(),
  persona: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Valide la liste blanche de sous-agents : ids réels, possédés par
 * l'utilisateur, actifs, et sans auto-référence.
 */
async function validateSubAgentIds(ownerId: string, agentId: string, subAgentIds: string[] | undefined): Promise<string | null> {
  if (!subAgentIds) return null;
  if (subAgentIds.includes(agentId)) return "Un agent ne peut pas se déléguer à lui-même.";
  const resolved = await Promise.all(subAgentIds.map((subId) => getAgentForOwner(ownerId, subId)));
  const missing = subAgentIds.filter((_, index) => !resolved[index] || resolved[index]!.status !== "active");
  return missing.length > 0 ? `Sous-agents introuvables ou inactifs : ${missing.join(", ")}` : null;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request); const { id } = await context.params;
    const record = await getAgentForOwner(user.uid, id);
    if (!record) return NextResponse.json({ error: "Agent introuvable", requestId }, { status: 404 });
    return NextResponse.json({ agent: { ...toSummary(record), systemPrompt: record.systemPrompt }, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Agent indisponible", requestId }, { status: errorStatus(error, 500) }); }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request); const { id } = await context.params;
    const parsed = PatchSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Mise a jour invalide", issues: parsed.error.flatten(), requestId }, { status: 400 });
    if (parsed.data.projectId && !(await getDeveloperProject(user.uid, parsed.data.projectId))) return NextResponse.json({ error: "Projet introuvable ou inaccessible", requestId }, { status: 403 });
    const subAgentError = await validateSubAgentIds(user.uid, id, parsed.data.subAgentIds);
    if (subAgentError) return NextResponse.json({ error: subAgentError, requestId }, { status: 422 });
    const record = await updateAgentForOwner(user.uid, id, parsed.data);
    if (!record) return NextResponse.json({ error: "Agent introuvable", requestId }, { status: 404 });
    return NextResponse.json({ agent: toSummary(record), requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Mise a jour impossible", requestId }, { status: errorStatus(error, 500) }); }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request); const { id } = await context.params;
    const deleted = await deleteAgentForOwner(user.uid, id);
    if (!deleted) return NextResponse.json({ error: "Agent introuvable", requestId }, { status: 404 });
    return NextResponse.json({ deleted: true, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Suppression impossible", requestId }, { status: errorStatus(error, 500) }); }
}
