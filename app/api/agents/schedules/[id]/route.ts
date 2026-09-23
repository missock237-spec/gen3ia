import { NextRequest, NextResponse } from "next/server";
import { errorStatus } from "@/lib/security/http-errors";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import {
  deleteSchedule,
  getSchedule,
  updateSchedule,
} from "@/lib/agents/scheduler";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const schedule = await getSchedule(user.uid, id);
    if (!schedule) return NextResponse.json({ error: "Schedule not found", requestId }, { status: 404 });
    return NextResponse.json({ schedule, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to get schedule", requestId }, { status: errorStatus(error, 401) });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const schedule = await updateSchedule(user.uid, id, await request.json());
    if (!schedule) return NextResponse.json({ error: "Schedule not found", requestId }, { status: 404 });
    return NextResponse.json({ schedule, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update schedule", requestId }, { status: errorStatus(error, 400) });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const deleted = await deleteSchedule(user.uid, id);
    if (!deleted) return NextResponse.json({ error: "Schedule not found", requestId }, { status: 404 });
    return NextResponse.json({ success: true, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to delete schedule", requestId }, { status: errorStatus(error, 401) });
  }
}
