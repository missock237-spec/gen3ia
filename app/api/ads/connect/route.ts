import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import {
  buildAuthorizationUrl,
  createOAuthState,
  type AdsProvider,
} from "@/lib/ads/ad-connections";
import { getAppUrl } from "@/lib/url/app-url";

const Schema = z.object({
  provider: z.enum(["google_ads", "meta_ads", "tiktok_ads"]),
});

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const { provider } = Schema.parse(await request.json());
    const redirectUri = `${getAppUrl()}/api/ads/callback`;
    const state = await createOAuthState({
      userId: guard.context.userId,
      provider: provider as AdsProvider,
      redirectUri,
    });

    return NextResponse.json({
      authorizationUrl: buildAuthorizationUrl(
        provider as AdsProvider,
        state,
        redirectUri,
      ),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Ads connection failed",
      },
      { status: 400 },
    );
  }
}
