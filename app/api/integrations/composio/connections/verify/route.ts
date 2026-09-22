import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { protectRoute } from "@/lib/security/route-guard";
import { verifyToolkitConnection } from "@/lib/integrations/composio/connections";

const Query = z.object({
  toolkit: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,64}$/),
});

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  const parsed = Query.safeParse({
    toolkit: new URL(request.url).searchParams.get("toolkit") ?? "",
  });
  if (!parsed.success) {
    return NextResponse.json({ verified: false, error: "Toolkit invalide." }, { status: 400 });
  }

  try {
    const result = await verifyToolkitConnection(guard.context.userId, parsed.data.toolkit, 12_000);
    return NextResponse.json(
      result,
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        verified: false,
        connection: null,
        error: error instanceof Error ? error.message : "Vérification de connexion impossible.",
      },
      { status: 502 },
    );
  }
}
