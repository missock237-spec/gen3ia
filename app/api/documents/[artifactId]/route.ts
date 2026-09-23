import { NextRequest, NextResponse } from "next/server";
import { errorStatus } from "@/lib/security/http-errors";

import {
  requireUser,
} from "@/lib/security/authenticated-request";

import {
  getArtifactById,
} from "@/lib/documents/repository";

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{
      artifactId: string;
    }>;
  },
) {
  try {
    const user =
      await requireUser(request);

    const {
      artifactId,
    } = await context.params;

    const artifact =
      await getArtifactById(
        user.uid,
        artifactId,
      );

    return NextResponse.json({
      success: true,
      artifact,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,

        error:
          error instanceof Error
            ? error.message
            : "Artifact not found.",
      },
      {
        status: errorStatus(error, 404),
      },
    );
  }
  }
