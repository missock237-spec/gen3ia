import { NextRequest, NextResponse } from "next/server";

import {
  protectRoute,
} from "@/lib/security/route-guard";

import {
  createExecutionWorkspace,
} from "@/lib/execution/workspace";

import {
  registerWorkspace,
} from "@/lib/execution/workspace-registry";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest
) {
  const guard =
    await protectRoute(request);

  if (!guard.ok) {
    return guard.response;
  }

  try {
    const executionId =
      crypto.randomUUID();

    const workspace =
      await createExecutionWorkspace(
        executionId
      );

    await registerWorkspace(
      workspace,
      guard.context.userId,
      executionId
    );

    return NextResponse.json({
      success: true,
      workspace: {
        id: workspace.id,
      },
    });
  } catch {
    return NextResponse.json(
      {
        success: false,
        error:
          "Unable to create workspace",
      },
      { status: 500 }
    );
  }
}
