import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { listScheduleRuns } from "@/lib/agents/scheduler";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();

  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? "25");
    const runs = await listScheduleRuns(user.uid, id, Number.isFinite(limit) ? limit : 25);

    if (!runs) {
      return NextResponse.json(
        { error: "Schedule not found", requestId },
        { status: 404, headers: { "x-request-id": requestId } },
      );
    }

    return NextResponse.json(
      { runs, requestId },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to list schedule runs", requestId },
      { status: 401, headers: { "x-request-id": requestId } },
    );
  }
}
