import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { authorizeAdsProvider } from "@/lib/integrations/composio/ads";

const Schema = z.object({
  provider: z.enum(["google_ads", "meta_ads", "tiktok_ads"]),
});

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const { provider } = Schema.parse(await request.json());
    const connection = await authorizeAdsProvider(
      guard.context.userId,
      provider,
    );

    return NextResponse.json({
      provider,
      connectionId: connection.id,
      authorizationUrl: connection.redirectUrl,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to start Ads connection.",
      },
      { status: 400 },
    );
  }
}
