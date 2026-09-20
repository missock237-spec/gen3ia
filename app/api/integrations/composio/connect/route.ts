import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { authorizeToolkit } from "@/lib/integrations/composio/connections";
import { verifyDeveloperProjectAccess } from "@/lib/extensions/repository";
import { upsertDeveloperProjectConnector } from "@/lib/developer/connectors";

const Schema = z.object({
  toolkit: z.string().min(2).max(64),
  projectId: z.string().min(1),
});

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const { toolkit, projectId } = Schema.parse(await request.json());
    await verifyDeveloperProjectAccess(guard.context.userId, projectId);
    const connection = await authorizeToolkit(guard.context.userId, toolkit);
    await upsertDeveloperProjectConnector({ projectId, userId: guard.context.userId, toolkit, connectionId: connection.id });

    return NextResponse.json({
      toolkit,
      projectId,
      connectionId: connection.id,
      authorizationUrl: connection.redirectUrl,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to start the connection flow.",
      },
      { status: 400 },
    );
  }
}
