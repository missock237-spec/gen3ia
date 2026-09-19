import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  protectRoute,
} from "@/lib/security/route-guard";

import {
  assertWorkspaceOwner,
} from "@/lib/execution/workspace-registry";

import {
  writeWorkspaceFile,
} from "@/lib/documents/file-engine";

const RequestSchema = z.object({
  workspaceId: z.string().min(1),
  relativePath: z.string().min(1).max(1024),
  content: z.string().max(
    10 * 1024 * 1024
  ),
});

export const runtime = "nodejs";

export async function POST(
  request: NextRequest
) {
  const guard =
    await protectRoute(request, { key: "files-write", rateLimit: { limit: 60, windowMs: 5 * 60 * 1000 } });

  if (!guard.ok) {
    return guard.response;
  }

  try {
    const body =
      await request.json();

    const input =
      RequestSchema.parse(body);

    const workspace =
      assertWorkspaceOwner(
        input.workspaceId,
        guard.context.userId
      );

    const path =
      await writeWorkspaceFile({
        workspaceRoot:
          workspace.root,

        relativePath:
          input.relativePath,

        content:
          input.content,
      });

    return NextResponse.json({
      success: true,
      path,
    });
  } catch (error) {
    if (
      error instanceof z.ZodError
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid request",
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "File write failed",
      },
      { status: 400 }
    );
  }
}
