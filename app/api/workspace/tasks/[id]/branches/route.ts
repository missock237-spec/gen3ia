import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { createBranch, listWorkspaceBranches, switchWorkspaceBranch } from "@/lib/agents/workspace";
import { errorStatus } from "@/lib/security/http-errors";

const Schema = z.object({ name: z.string().trim().min(1).max(80) });
const SwitchSchema = z.object({ branchId: z.string().uuid() });

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    return NextResponse.json({ success: true, branches: await listWorkspaceBranches(user.uid, id) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to list branches." }, { status: errorStatus(error, 400) });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const body = await request.json();
    if (body?.branchId) {
      const parsed = SwitchSchema.parse(body);
      return NextResponse.json({ success: true, task: await switchWorkspaceBranch(user.uid, id, parsed.branchId) });
    }
    const parsed = Schema.parse(body);
    return NextResponse.json({ success: true, branch: await createBranch(user.uid, id, parsed.name) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Branch operation failed." }, { status: errorStatus(error, 400) });
  }
}
