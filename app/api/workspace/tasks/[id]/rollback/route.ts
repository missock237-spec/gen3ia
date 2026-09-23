import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { listWorkspaceSnapshots, rollbackTask } from "@/lib/agents/workspace";
import { errorStatus } from "@/lib/security/http-errors";

const Schema = z.object({ snapshotId: z.string().uuid() });

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    return NextResponse.json({ success: true, snapshots: await listWorkspaceSnapshots(user.uid, id) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to list snapshots." }, { status: errorStatus(error, 400) });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const body = Schema.parse(await request.json());
    return NextResponse.json({ success: true, task: await rollbackTask(user.uid, id, body.snapshotId) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Rollback failed." }, { status: errorStatus(error, 400) });
  }
}
