import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { assertSupportedToolkit, getToolkitTools } from "@/lib/integrations/composio/connections";

export const runtime = "nodejs";

function compactTool(tool: unknown) {
  const value = tool as Record<string, unknown>;
  const toolkit = value.toolkit as Record<string, unknown> | undefined;
  const parameters =
    (value.inputParameters as Record<string, unknown> | undefined) ??
    (value.parameters as Record<string, unknown> | undefined);
  return {
    slug: typeof value.slug === "string" ? value.slug : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
    description: typeof value.description === "string" ? value.description.slice(0, 500) : undefined,
    toolkit: typeof toolkit?.slug === "string" ? toolkit.slug : undefined,
    parameters,
  };
}

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const url = new URL(request.url);
    const toolkit = url.searchParams.get("toolkit") ?? "";
    assertSupportedToolkit(toolkit);
    const search = url.searchParams.get("search") ?? undefined;
    const tools = await getToolkitTools(guard.context.userId, toolkit, search || undefined);
    const list = Array.isArray(tools) ? tools.map(compactTool).slice(0, 100) : [];
    return NextResponse.json({ toolkit, tools: list }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to list toolkit tools.",
      },
      { status: 400 },
    );
  }
}
