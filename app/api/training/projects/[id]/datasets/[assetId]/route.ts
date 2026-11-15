import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

import { deleteDataset, getDataset, saveDataset } from "@/lib/training/repository";
import { datasetSplitSchema } from "@/lib/training/types";

const patchDatasetSchema = z.object({
  split: datasetSplitSchema,
});

/** PATCH /api/training/projects/[id]/datasets/[assetId] — change le split (train/validation/test). */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id, assetId } = await params;
    const body = (await request.json().catch(() => null)) as unknown;
    const parsed = patchDatasetSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Split invalide : train, validation, test ou unassigned.", requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }
    const existing = await getDataset(user.uid, id, assetId);
    if (!existing) {
      return NextResponse.json(
        { error: "Dataset introuvable.", requestId },
        { status: 404, headers: { "x-request-id": requestId } },
      );
    }
    const updated = { ...existing, split: parsed.data.split, updatedAt: new Date().toISOString() };
    await saveDataset(user.uid, updated);
    return NextResponse.json({ dataset: updated, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Mise à jour impossible"), requestId },
      { status: errorStatus(error, 400), headers: { "x-request-id": requestId } },
    );
  }
}

/** DELETE /api/training/projects/[id]/datasets/[assetId] — supprime le dataset et son fichier. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; assetId: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id, assetId } = await params;
    const removed = await deleteDataset(user.uid, id, assetId);
    if (!removed) {
      return NextResponse.json(
        { error: "Dataset introuvable.", requestId },
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
