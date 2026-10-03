import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { listTerminalSessions } from "@/lib/agents/runtime/terminal-sessions";

export const runtime = "nodejs";

/** GET /api/terminal/sessions — sessions terminal de l'utilisateur (agents + workspaces). */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? 30);
    const sessions = await listTerminalSessions(user.uid, Number.isFinite(limit) ? limit : 30);
    return NextResponse.json({ sessions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sessions indisponibles";
    return NextResponse.json({ error: message }, { status: errorStatus(error, 500) });
  }
}
