import { NextRequest, NextResponse } from "next/server";
import {
  consumeOAuthState,
  exchangeCode,
  saveConnection,
} from "@/lib/ads/ad-connections";
import { getAppUrl } from "@/lib/url/app-url";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");

  if (!state || !code) {
    return NextResponse.json(
      { error: "OAuth callback is incomplete." },
      { status: 400 },
    );
  }

  try {
    const context = await consumeOAuthState(state);
    const token = await exchangeCode(
      context.provider,
      code,
      context.redirectUri,
    );

    await saveConnection({
      userId: context.userId,
      provider: context.provider,
      ...token,
    });

    return NextResponse.redirect(
      new URL(
        `/studio?ads_connected=${encodeURIComponent(context.provider)}`,
        getAppUrl(),
      ),
    );
  } catch (error) {
    console.error("[ads/callback] échec OAuth", error instanceof Error ? error.name : "unknown");
    return NextResponse.redirect(
      new URL(
        `/studio?ads_error=${encodeURIComponent(
          // Code générique : le message interne (fournisseur, jeton) ne doit
          // jamais transiter dans une URL (historique, logs, Referer).
          "connection_failed",
        )}`,
        getAppUrl(),
      ),
    );
  }
}
