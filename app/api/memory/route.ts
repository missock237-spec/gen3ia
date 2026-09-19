import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { listMemories, remember, forget } from "@/lib/memory/user-memory";

const WriteSchema = z.object({ key: z.string().min(1).max(160), value: z.unknown() });
const DeleteSchema = z.object({ key: z.string().min(1).max(160) });

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, { key: "memory", rateLimit: { limit: 120, windowMs: 5 * 60 * 1000 } }); if (!guard.ok) return guard.response;
  return NextResponse.json({ memories: await listMemories(guard.context.userId) }, { headers: { "cache-control": "no-store" } });
}
export async function POST(request: NextRequest) {
  const guard = await protectRoute(request, { key: "memory", rateLimit: { limit: 120, windowMs: 5 * 60 * 1000 } }); if (!guard.ok) return guard.response;
  try { const input = WriteSchema.parse(await request.json()); await remember({ userId: guard.context.userId, key: input.key, value: input.value, source: "user" }); return NextResponse.json({ ok: true }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Memory write failed" }, { status: 400 }); }
}
export async function DELETE(request: NextRequest) {
  const guard = await protectRoute(request, { key: "memory", rateLimit: { limit: 120, windowMs: 5 * 60 * 1000 } }); if (!guard.ok) return guard.response;
  try { const input = DeleteSchema.parse(await request.json()); await forget(guard.context.userId, input.key); return NextResponse.json({ ok: true }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Memory delete failed" }, { status: 400 }); }
}
