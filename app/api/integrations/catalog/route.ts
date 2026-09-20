import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { CONNECTION_CATEGORIES, listComposioToolkits } from "@/lib/integrations/composio/connections";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const url = new URL(request.url);
    const search = url.searchParams.get("search")?.trim() || undefined;
    const category = url.searchParams.get("category")?.trim() || undefined;
    const cursor = url.searchParams.get("cursor")?.trim() || undefined;
    const limit = Number(url.searchParams.get("limit") || "50");

    const catalog = await listComposioToolkits({ search, category, cursor, limit });
    return NextResponse.json(
      { ...catalog, categories: CONNECTION_CATEGORIES, provider: "composio" },
      { headers: { "cache-control": "private, max-age=60, stale-while-revalidate=300" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load Composio catalog" },
      { status: 502 },
    );
  }
}
