import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  protectRoute,
} from "@/lib/security/route-guard";

import {
  assertWorkspaceOwner,
} from "@/lib/execution/workspace-registry";

import {
  readWorkspaceFile,
} from "@/lib/documents/file-engine";

const RequestSchema = z.object({
  workspaceId: z.string().min(1),
  relativePath: z.string().min(1).max(1024),
});

export const runtime = "nodejs";

export async function POST(
  request: NextRequest
) {
  const guard =
    await protectRoute(request, { key: "files-read", rateLimit: { limit: 120, windowMs: 5 * 60 * 1000 } });

  if (!guard.ok) {
    return guard.response;
  }

  try {
    const input =
      RequestSchema.parse(
        await request.json()
      );

    const workspace =
      assertWorkspaceOwner(
        input.workspaceId,
        guard.context.userId
      );

    const data =
      await readWorkspaceFile({
        workspaceRoot:
          workspace.root,

        relativePath:
          input.relativePath,
      });

    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        "content-type":
          "application/octet-stream",
        "cache-control":
          "no-store",
      },
    });
  } catch (error) {
    if (
      error instanceof z.ZodError
    ) {
      return NextResponse.json(
        {
          error: "Invalid request",
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "File read failed",
      },
      { status: 400 }
    );
  }
}
