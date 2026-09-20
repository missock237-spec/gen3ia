import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { commitUpload } from "@/lib/storage/permanent-user-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PartSchema = z.object({
  partNumber: z.number().int().min(1).max(10000),
  etag: z.string().min(4).max(128),
});
const CommitSchema = z.object({
  uploadId: z.string().min(8).max(64),
  parts: z.array(PartSchema).min(1).max(10000),
});

/** Assemble les pieces deposees chez R2 et enregistre la metadonnee. */
export async function POST(request: NextRequest) {
  const guard = await protectRoute(request, { key: "storage-commit", rateLimit: { limit: 60, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const input = CommitSchema.parse(await request.json());
    const file = await commitUpload({ userId: guard.context.userId, uploadId: input.uploadId, parts: input.parts });
    return NextResponse.json({ file }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Commit failed" }, { status: 400 });
  }
}
