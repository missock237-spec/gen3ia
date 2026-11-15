import { errorStatus } from "@/lib/security/http-errors";
import {  NextRequest,
  NextResponse,
} from "next/server";

import { z } from "zod";

import {
  requireUser,
} from "@/lib/security/authenticated-request";

import {
  deployProject,
} from "@/lib/deployments/service";

const DeploymentSchema =
  z.object({
    name:
      z.string()
        .min(1)
        .max(100)
        .regex(
          /^[A-Za-z0-9._-]+$/,
        ),

    description:
      z.string()
        .max(350)
        .optional(),

    visibility:
      z.enum([
        "private",
        "public",
      ]),

    github:
      z.boolean()
        .default(true),

    vercel:
      z.boolean()
        .default(false),

    render:
      z.boolean()
        .default(false),

    renderOwnerId:
      z.string()
        .optional(),

    repository:
      z.string()
        .optional(),

    branch:
      z.string()
        .optional(),
  });

export async function POST(
  request: NextRequest,
) {
  try {
    const user =
      await requireUser(request);

    const body =
      await request.json();

    const input =
      DeploymentSchema.parse(
        body,
      );

    const result =
      await deployProject({
        ...input,

        owner:
          user.uid,
      });

    return NextResponse.json({
      success:
        true,

      result,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success:
          false,

        error:
          error instanceof Error
            ? error.message
            : "Deployment failed.",
      },
      {
        status: errorStatus(error, 400),
      },
    );
  }
}
