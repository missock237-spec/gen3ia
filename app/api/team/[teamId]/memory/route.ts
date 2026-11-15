import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { reduceTeamCognitiveLoad } from "@/lib/memory/team-cognitive-load";

const Schema = z.object({ objective: z.string().max(5000).optional(), memories: z.array(z.object({ id: z.string().max(256), text: z.string().max(10000), importance: z.number().min(0).max(1).optional(), tags: z.array(z.string().max(64)).max(20).optional(), source: z.string().max(128).optional() })).max(500).optional(), recentMessages: z.array(z.object({ role: z.string().max(40), content: z.string().max(10000) })).max(100).optional(), decisions: z.array(z.string().max(2000)).max(50).optional(), constraints: z.array(z.string().max(2000)).max(50).optional() });

export async function POST(request: NextRequest, { params }: { params: Promise<{ teamId: string }> }) {
  try { const { teamId } = await params; const token = await verifyFirebaseAuth(request); const body = Schema.parse(await request.json()); return NextResponse.json(await reduceTeamCognitiveLoad({ userId: token.uid, teamId, workspace: body })); }
  catch (error) { const message = error instanceof Error ? error.message : "Team memory reduction failed"; const status = /authorization|token|revoked|scheme/i.test(message) ? 401 : /team|membership|archived|role/i.test(message) ? 403 : 400; return NextResponse.json({ error: message }, { status }); }
}
