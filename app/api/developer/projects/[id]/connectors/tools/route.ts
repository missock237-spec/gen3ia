import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { verifyDeveloperProjectAccess } from "@/lib/extensions/repository";
import { getProjectComposioTools } from "@/lib/integrations/composio/connections";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  try {
    await verifyDeveloperProjectAccess(guard.context.userId, id);
    const search = new URL(request.url).searchParams.get("search")?.trim() || undefined;
    const tools = await getProjectComposioTools(guard.context.userId, id, search);
    return NextResponse.json({ tools });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to list project tools." }, { status: 400 });
  }
}