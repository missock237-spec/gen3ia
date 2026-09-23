import { errorStatus } from "@/lib/security/http-errors";
import {  NextRequest,
  NextResponse,
} from "next/server";

import {
  requireUser,
} from "@/lib/security/authenticated-request";

import {
  listSkills,
} from "@/lib/skills/repository";

export async function GET(
  request: NextRequest,
) {
  try {
    const user =
      await requireUser(request);

    const url =
      new URL(request.url);

    const category =
      url.searchParams.get(
        "category",
      ) ?? undefined;

    const status =
      url.searchParams.get(
        "status",
      ) ?? "active";

    const skills =
      await listSkills({
        category,
        status,
      });

    const visible =
      skills.filter(
        (skill) =>
          skill.visibility ===
            "system" ||
          skill.visibility ===
            "marketplace" ||
          skill.authorId ===
            user.uid,
      );

    return NextResponse.json({
      skills: visible,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to list skills.",
      },
      {
        status: errorStatus(error, 401),
      },
    );
  }
}
