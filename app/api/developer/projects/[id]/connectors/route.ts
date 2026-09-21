import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { assertDeveloperRole } from "@/lib/access/platform";
import { verifyDeveloperProjectAccess } from "@/lib/extensions/repository";
import { listDeveloperProjectConnectors, removeDeveloperProjectConnector } from "@/lib/developer/connectors";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;

  try {
    await assertDeveloperRole(guard.context.userId);
    await verifyDeveloperProjectAccess(guard.context.userId, id);
    return NextResponse.json({
      connectors: await listDeveloperProjectConnectors(guard.context.userId, id),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Forbidden" },
      { status: 403 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;

  try {
    await assertDeveloperRole(guard.context.userId);
    await verifyDeveloperProjectAccess(guard.context.userId, id);
    const toolkit = new URL(request.url).searchParams.get("toolkit")?.trim() || "";
    if (!toolkit) {
      return NextResponse.json({ error: "toolkit is required" }, { status: 400 });
    }
    await removeDeveloperProjectConnector(guard.context.userId, id, toolkit);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to remove connector" },
      { status: 403 },
    );
  }
}
