import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { storePermanentFile } from "@/lib/storage/permanent-user-storage";
import { completeCameraCapture } from "@/lib/camera/agent-camera";
import { billUsage } from "@/lib/billing/media-meter";
import { randomUUID } from "node:crypto";
import { errorStatus } from "@/lib/security/http-errors";

const Schema = z.object({ requestId: z.string().uuid() });
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const guard = await protectRoute(request); if (!guard.ok) return guard.response;
  try {
    const { requestId } = Schema.parse({ requestId: request.headers.get("x-camera-request-id") });
    const content = request.headers.get("content-type") || "";
    if (!content.startsWith("image/")) return NextResponse.json({ error: "Camera upload must be an image." }, { status: 415 });
    const bytes = Buffer.from(await request.arrayBuffer()); if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) throw new Error("Camera image exceeds the allowed size.");
    const stored = await storePermanentFile({ userId: guard.context.userId, filename: `camera-${requestId}.jpg`, content: bytes, contentType: content });
    await completeCameraCapture({ userId: guard.context.userId, requestId, storagePath: stored.path });
    await billUsage({ userId: guard.context.userId, executionId: randomUUID(), kind: "storage_write", quantity: Math.max(bytes.length / (1024 ** 3), 1 / (1024 ** 3)), metadata: { source: "camera", requestId } });
    return NextResponse.json({ ok: true, file: stored });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Camera capture failed" }, { status: errorStatus(error, 400) }); }
}
