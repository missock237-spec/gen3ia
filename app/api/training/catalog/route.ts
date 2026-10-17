import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

import { buildCatalog } from "@/lib/training/catalog";

/** GET /api/training/catalog — moteurs, modèles de base, fournisseurs sondés, quotas. */
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    await requireUser(request);
    const catalog = await buildCatalog();
    return NextResponse.json({ catalog, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Catalogue indisponible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}
