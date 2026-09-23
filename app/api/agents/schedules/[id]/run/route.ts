import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { triggerScheduleNow } from "@/lib/agents/scheduler";

interface RouteContext { params: Promise<{ id: string }>; }

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`schedule-manual-run:${user.uid}`, { limit: 10, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Manual schedule execution limit reached", requestId },
        { status: 429, headers: { "x-request-id": requestId } },
      );
    }

    const { id } = await context.params;
    const result = await triggerScheduleNow(user.uid, id);
    return NextResponse.json(
      { ok: true, ...result, requestId },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to execute schedule";
    const status = message === "Schedule not found" ? 404 : message.includes("already running") ? 409 : 400;
    return NextResponse.json(
      { error: message, requestId },
      { status, headers: { "x-request-id": requestId } },
    );
  }
}
