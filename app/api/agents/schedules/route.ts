import { NextRequest, NextResponse } from "next/server";
import { errorStatus } from "@/lib/security/http-errors";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import {
  createSchedule,
  listSchedules,
} from "@/lib/agents/scheduler";
import { executionLogger, safeError } from "@/lib/observability/logger";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    return NextResponse.json(
      { schedules: await listSchedules(user.uid), requestId },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to list schedules", requestId },
      { status: errorStatus(error, 401), headers: { "x-request-id": requestId } },
    );
  }
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  const log = executionLogger({ requestId });

  try {
    const user = await requireUser(request);
    const body = await request.json();
    const schedule = await createSchedule(user.uid, body);

    return NextResponse.json(
      { schedule, requestId },
      { status: 201, headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    log.warn({ event: "agent.schedule.create.failed", error: safeError(error) }, "Schedule creation failed");
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to create schedule", requestId },
      { status: errorStatus(error, 400), headers: { "x-request-id": requestId } },
    );
  }
}
