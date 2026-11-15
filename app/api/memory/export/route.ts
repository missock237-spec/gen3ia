import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { errorStatus } from "@/lib/security/http-errors";
import { exportUserData } from "@/lib/memory/privacy";

/**
 * GET /api/memory/export — portabilité RGPD (Task 42, axe 6) : tout ce que
 * Gen3ia retient sur ce compte, dans un JSON portable auto-descriptif.
 * Réponse en pièce jointe téléchargeable (Content-Disposition).
 */

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, { key: "memory-export", rateLimit: { limit: 5, windowMs: 60 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  let data: Awaited<ReturnType<typeof exportUserData>>;
  try {
    data = await exportUserData(guard.context.userId);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Export impossible pour le moment." }, { status: errorStatus(error, 500) });
  }
  const stamp = data.exportedAt.slice(0, 10);
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="gen3ia-memoire-${stamp}.json"`,
      "cache-control": "no-store",
    },
  });
}
