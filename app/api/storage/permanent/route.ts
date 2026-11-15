import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { storePermanentFile, createPermanentDownloadUrl, deletePermanentFile, listPermanentFilesWithMetadata, getUserStorageUsage } from "@/lib/storage/permanent-user-storage";
import { billUsage } from "@/lib/billing/media-meter";
import { randomUUID } from "node:crypto";
import { errorStatus } from "@/lib/security/http-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request); if (!guard.ok) return guard.response;
  const path = request.nextUrl.searchParams.get("path");
  try {
    if (path) return NextResponse.json({ url: await createPermanentDownloadUrl(guard.context.userId, path) });
    const [files, usage] = await Promise.all([
      listPermanentFilesWithMetadata(guard.context.userId),
      getUserStorageUsage(guard.context.userId),
    ]);
    return NextResponse.json({ files, usage }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Storage operation failed" }, { status: errorStatus(error, 400) }); }
}

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request); if (!guard.ok) return guard.response;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "file is required" }, { status: 400 });
    const buffer = Buffer.from(await file.arrayBuffer());
    const stored = await storePermanentFile({ userId: guard.context.userId, filename: file.name, content: buffer, contentType: file.type || "application/octet-stream" });
    await billUsage({ userId: guard.context.userId, executionId: randomUUID(), kind: "storage_write", quantity: Math.max(buffer.length / (1024 ** 3), 1 / (1024 ** 3)), metadata: { filename: stored.filename, sizeBytes: String(buffer.length) } });
    return NextResponse.json({ file: stored }, { status: 201 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "File upload failed" }, { status: errorStatus(error, 400) }); }
}

export async function DELETE(request: NextRequest) {
  const guard = await protectRoute(request); if (!guard.ok) return guard.response;
  try { const body = await request.json(); if (typeof body.path !== "string") throw new Error("path is required"); await deletePermanentFile(guard.context.userId, body.path); return NextResponse.json({ ok: true }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "File delete failed" }, { status: errorStatus(error, 400) }); }
}
