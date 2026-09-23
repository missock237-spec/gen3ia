import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { validateUploadBatch } from "@/lib/storage/upload-policy";
import { abortUpload, cleanupExpiredSessions, createUploadSessions, getUserStorageUsage } from "@/lib/storage/permanent-user-storage";
import { errorStatus } from "@/lib/security/http-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IntentSchema = z.object({
  filename: z.string().min(1).max(300),
  contentType: z.string().min(0).max(160).optional().default(""),
  sizeBytes: z.number().int().positive(),
});

const CreateSchema = z.object({ files: z.array(IntentSchema).min(1).max(10) });

/** Ouvre une session de televersement chunked (validation + quota inclus). */
export async function POST(request: NextRequest) {
  const guard = await protectRoute(request, { key: "storage-session", rateLimit: { limit: 40, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    await cleanupExpiredSessions(guard.context.userId);
    const input = CreateSchema.parse(await request.json());
    const usage = await getUserStorageUsage(guard.context.userId);
    const validation = validateUploadBatch(
      input.files.map((file) => ({ filename: file.filename, contentType: file.contentType ?? "", sizeBytes: file.sizeBytes })),
      { alreadyUsedBytes: usage.usedBytes },
    );
    if (!validation.ok) {
      return NextResponse.json({ error: validation.rejections[0]?.reason ?? "Lot refuse.", rejections: validation.rejections }, { status: 400 });
    }
    const sessions = await createUploadSessions({ userId: guard.context.userId, intents: validation.intents });
    return NextResponse.json({ sessions }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Session creation failed" }, { status: errorStatus(error, 400) });
  }
}

/** Annule une session et purge ses chunks temporaires. */
export async function DELETE(request: NextRequest) {
  const guard = await protectRoute(request, { key: "storage-session", rateLimit: { limit: 60, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const uploadId = request.nextUrl.searchParams.get("uploadId");
    if (!uploadId) throw new Error("uploadId is required");
    await abortUpload({ userId: guard.context.userId, uploadId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Session abort failed" }, { status: errorStatus(error, 400) });
  }
}
