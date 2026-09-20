import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { listHubConnections, revokeHubConnection } from "@/lib/integrations/composio/connections";

const DeleteSchema = z.object({
  connectionId: z.string().min(1).max(256),
});

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const connections = await listHubConnections(guard.context.userId);
    return NextResponse.json(
      { connections },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to list connections.",
      },
      { status: 400 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const { connectionId } = DeleteSchema.parse(await request.json());
    await revokeHubConnection(guard.context.userId, connectionId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to revoke the connection.",
      },
      { status: 400 },
    );
  }
}
