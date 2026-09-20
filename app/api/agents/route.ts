import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireUser } from "@/lib/security/authenticated-request";
import { rateLimit } from "@/lib/security/rate-limit";
import { createAgentRecord, listAgentsByOwner, toSummary } from "@/lib/agents/repository";
import { AgentRecordSchema } from "@/lib/agents/schema";
import { getDeveloperProject } from "@/lib/developer/projects";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const projectId = request.nextUrl.searchParams.get("projectId")?.trim() || undefined;
    if (projectId && !(await getDeveloperProject(user.uid, projectId))) return NextResponse.json({ error: "Projet introuvable", requestId }, { status: 404 });
    const agents = await listAgentsByOwner(user.uid, projectId);
    return NextResponse.json({ agents: agents.map(toSummary), requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Liste des agents indisponible", requestId }, { status: error instanceof Error && error.message.includes("auth") ? 401 : 500 });
  }
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const limit = rateLimit(`agent-create:${user.uid}`, { limit: 20, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Limite de creation d'agents atteinte, reessayez plus tard.", requestId }, { status: 429 });
    const parsed = AgentRecordSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Donnees d'agent invalides", issues: parsed.error.flatten(), requestId }, { status: 400 });
    if (parsed.data.projectId && !(await getDeveloperProject(user.uid, parsed.data.projectId))) return NextResponse.json({ error: "Projet introuvable ou inaccessible", requestId }, { status: 403 });
    const record = await createAgentRecord(user.uid, parsed.data);
    return NextResponse.json({ agent: toSummary(record), requestId }, { status: 201, headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Creation d'agent impossible", requestId }, { status: 500 });
  }
}
