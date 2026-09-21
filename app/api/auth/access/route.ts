import { NextResponse } from "next/server";

import { getPlatformAccess } from "@/lib/access/platform";

export async function GET(request: Request) {
  try {
    const access = await getPlatformAccess(request);
    return NextResponse.json(access, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch {
    return NextResponse.json(
      {
        authenticated: false,
        role: "user",
        canDeveloper: false,
        canAdmin: false,
      },
      { status: 401, headers: { "cache-control": "private, no-store" } },
    );
  }
}
