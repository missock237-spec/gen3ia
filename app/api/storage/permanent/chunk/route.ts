import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { CHUNK_SIZE_BYTES } from "@/lib/storage/upload-policy";
import { recordChunk } from "@/lib/storage/permanent-user-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ecrit un chunk binaire (3 Mo max) dans la zone temporaire de la session.
 * Le corps brut evite tout encodage base64 : 3 Mo restent sous la limite
 * serverless Vercel (~4,5 Mo) meme avec les en-tetes.
 */
export async function PUT(request: NextRequest) {
  const guard = await protectRoute(request, { key: "storage-chunk", rateLimit: { limit: 900, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const uploadId = request.nextUrl.searchParams.get("uploadId");
    const index = Number(request.nextUrl.searchParams.get("index"));
    if (!uploadId || !Number.isInteger(index)) throw new Error("uploadId et index requis.");

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > CHUNK_SIZE_BYTES) throw new Error("Chunk trop volumineux.");

    const content = Buffer.from(await request.arrayBuffer());
    if (content.length === 0) throw new Error("Chunk vide.");
    const result = await recordChunk({ userId: guard.context.userId, uploadId, index, content });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Chunk upload failed" }, { status: 400 });
  }
}
