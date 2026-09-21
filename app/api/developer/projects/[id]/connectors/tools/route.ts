import { NextRequest, NextResponse } from "next/server";
import { protectRoute } from "@/lib/security/route-guard";
import { assertDeveloperRole } from "@/lib/access/platform";
import { verifyDeveloperProjectAccess } from "@/lib/extensions/repository";
import { getProjectComposioTools } from "@/lib/integrations/composio/connections";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;

  try {
    await assertDeveloperRole(guard.context.userId);
    await verifyDeveloperProjectAccess(guard.context.userId, id);
    const search = new URL(request.url).searchParams.get("search")?.trim() || undefined;
    const raw = await getProjectComposioTools(guard.context.userId, id, search);
    const payload = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const items = Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.tools)
        ? payload.tools
        : Array.isArray(raw)
          ? raw
          : Object.values(payload).filter((value) => value && typeof value === "object");

    const tools = items.map((item) => {
      const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const toolkitValue = value.toolkit ?? value.toolkit_slug ?? value.toolkitSlug;
      const toolkit =
        typeof toolkitValue === "string"
          ? toolkitValue
          : toolkitValue &&
              typeof toolkitValue === "object" &&
              typeof (toolkitValue as Record<string, unknown>).slug === "string"
            ? String((toolkitValue as Record<string, unknown>).slug)
            : "";
      const slug =
        typeof value.slug === "string"
          ? value.slug
          : typeof value.name === "string"
            ? value.name
            : "";

      return {
        slug,
        name: typeof value.name === "string" ? value.name : slug,
        toolkit,
        description: typeof value.description === "string" ? value.description : "",
        inputSchema: value.inputSchema ?? value.input_schema ?? null,
      };
    }).filter((tool) => tool.slug && tool.toolkit);

    return NextResponse.json({ tools });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to list project tools." },
      { status: 403 },
    );
  }
}
