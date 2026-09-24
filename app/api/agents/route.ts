import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { createAgentRecord, getAgentForOwner, listAgentsByOwner, toSummary } from "@/lib/agents/repository";
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
    return NextResponse.json({ ...errorBody(error, "Liste des agents indisponible"), requestId }, { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`agent-create:${user.uid}`, { limit: 20, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Limite de creation d'agents atteinte, reessayez plus tard.", requestId }, { status: 429 });
    const parsed = AgentRecordSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Donnees d'agent invalides", issues: parsed.error.flatten(), requestId }, { status: 400 });
    if (parsed.data.projectId && !(await getDeveloperProject(user.uid, parsed.data.projectId))) return NextResponse.json({ error: "Projet introuvable ou inaccessible", requestId }, { status: 403 });
    // Sous-agents : liste blanche réelle (ids possédés, actifs, pas d'auto-référence).
    const subIds = parsed.data.subAgentIds ?? [];
    if (subIds.length > 0) {
      const resolved = await Promise.all(subIds.map((subId) => getAgentForOwner(user.uid, subId)));
      const invalid = subIds.filter((subId, index) => !resolved[index] || resolved[index]!.status !== "active");
      if (invalid.length > 0) return NextResponse.json({ error: `Sous-agents introuvables ou inactifs : ${invalid.join(", ")}`, requestId }, { status: 422 });
    }
    const record = await createAgentRecord(user.uid, parsed.data);
    return NextResponse.json({ agent: toSummary(record), requestId }, { status: 201, headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json({ ...errorBody(error, "Creation d'agent impossible"), requestId }, { status: errorStatus(error) });
  }
}
