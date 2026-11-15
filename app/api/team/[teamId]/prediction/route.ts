import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { anticipateTeamFailures } from "@/lib/prediction/failure-anticipation";

const StepSchema = z.object({ id: z.string().trim().min(1).max(256), name: z.string().max(256).optional(), toolName: z.string().max(256).optional(), type: z.string().max(64).optional(), timeoutMs: z.number().int().min(1).max(120000).optional(), maxRetries: z.number().int().min(0).max(10).optional(), sideEffect: z.boolean().optional(), requiresApproval: z.boolean().optional(), input: z.record(z.string(), z.unknown()).optional() });
const Schema = z.object({ steps: z.array(StepSchema).min(1).max(100) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  try { const { teamId } = await params; const token = await verifyFirebaseAuth(request); const body = Schema.parse(await request.json()); return NextResponse.json(await anticipateTeamFailures({ userId: token.uid, teamId, steps: body.steps })); }
  catch (error) { const message = error instanceof Error ? error.message : "Team failure prediction failed"; const status = /authorization|token|revoked|scheme/i.test(message) ? 401 : /team|membership|archived|role/i.test(message) ? 403 : 400; return NextResponse.json({ error: message }, { status }); }
}
