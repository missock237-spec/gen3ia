import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

import { deleteModel } from "@/lib/training/repository";

/** DELETE /api/training/projects/[id]/models/[assetId] — supprime l'asset et son fichier. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id, assetId } = await params;
    const removed = await deleteModel(user.uid, id, assetId);
    if (!removed) {
      return NextResponse.json(
        { error: "Modèle introuvable.", requestId },
        { status: 404, headers: { "x-request-id": requestId } },
      );
    }
    return NextResponse.json({ removed: true, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Suppression impossible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}
