import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { listArtifacts } from "@/lib/domain/artifacts/repository";

const QuerySchema = z.object({
  conversationId: z.string().trim().min(1).max(128).optional(),
  projectId: z.string().trim().min(1).max(128).optional(),
  runId: z.string().trim().min(1).max(128).optional(),
  type: z.enum(["code", "document", "table", "image", "report", "file"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** Livrables standardisés : code, documents, tableaux, images, rapports, fichiers. */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const raw = Object.fromEntries(new URL(request.url).searchParams.entries());
    const filters = QuerySchema.parse(raw);
    const artifacts = await listArtifacts(user.uid, filters);
    return NextResponse.json({ artifacts });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Impossible de charger les artefacts."), { status: errorStatus(error, 400) });
  }
}
