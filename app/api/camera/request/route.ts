import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { requestCameraCapture } from "@/lib/camera/agent-camera";

const Schema = z.object({ executionId: z.string().min(1), agentId: z.string().max(160).optional(), reason: z.string().min(3).max(1000), facingMode: z.enum(["user", "environment"]).optional() });
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request, { key: "camera-request", rateLimit: { limit: 10, windowMs: 10 * 60 * 1000 } }); if (!guard.ok) return guard.response;
  try { const body = Schema.parse(await request.json()); return NextResponse.json(await requestCameraCapture({ userId: guard.context.userId, ...body })); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Camera request failed" }, { status: 400 }); }
}
