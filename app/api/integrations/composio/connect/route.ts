import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { authorizeToolkit } from "@/lib/integrations/composio/connections";

const Schema = z.object({
  toolkit: z.string().min(2).max(64),
});

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const { toolkit } = Schema.parse(await request.json());
    const connection = await authorizeToolkit(guard.context.userId, toolkit);

    return NextResponse.json({
      toolkit,
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
