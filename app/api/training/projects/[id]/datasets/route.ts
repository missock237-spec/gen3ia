import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { putObject } from "@/lib/storage/r2";
import { newUlid, userDir } from "@/lib/storage/user-data-store";

import { assertAssetQuota, assertUploadSize } from "@/lib/training/quotas";
import { getProject, listDatasets, saveDataset } from "@/lib/training/repository";
import { validateDatasetFile } from "@/lib/training/validation/dataset-files";
import { datasetAssetSchema, datasetSplitSchema } from "@/lib/training/types";

/** GET /api/training/projects/[id]/datasets — liste des datasets du projet. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const project = await getProject(user.uid, id);
    if (!project) {
      return NextResponse.json({ error: "Projet introuvable.", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }
    const datasets = await listDatasets(user.uid, id);
    return NextResponse.json({ datasets, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Liste des datasets indisponible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}

/**
 * POST /api/training/projects/[id]/datasets — téléverse et ANALYSE un dataset.
 * multipart/form-data : file (csv/json/jsonl/txt) + split (train|validation|test|unassigned).
 * Le contenu est réellement parsé : stats, doublons, PII (avertissement RGPD).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const project = await getProject(user.uid, id);
    if (!project) {
      return NextResponse.json({ error: "Projet introuvable.", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    }
    await assertAssetQuota("datasets", user.uid, id);

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    const splitRaw = form?.get("split");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Fichier manquant : joignez le dataset (champ « file »).", requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }
    const splitParsed = datasetSplitSchema.safeParse(typeof splitRaw === "string" ? splitRaw : "unassigned");
    const split = splitParsed.success ? splitParsed.data : "unassigned";

    const name = file.name.slice(0, 180);
    const buffer = Buffer.from(await file.arrayBuffer());
    assertUploadSize(buffer.byteLength, "Dataset");

    const report = validateDatasetFile(name, buffer);
    if (report.status === "rejected") {
      return NextResponse.json(
        { error: "Dataset refusé après validation.", findings: report.findings, requestId },
        { status: 422, headers: { "x-request-id": requestId } },
      );
    }

    const assetId = newUlid();
    const storageKey = `${userDir(user.uid, "training-files", id)}/${assetId}`;
    await putObject({
      key: storageKey,
      body: buffer,
      contentType: file.type || "application/octet-stream",
      contentLength: buffer.byteLength,
    });

    const stamp = new Date().toISOString();
    const asset = datasetAssetSchema.parse({
      id: assetId,
      projectId: id,
      ownerId: user.uid,
      name,
      format: report.format,
      storageKey,
      sizeBytes: buffer.byteLength,
      sha256: report.sha256,
      split,
      stats: report.stats,
      status: report.status,
      findings: report.findings,
      createdAt: stamp,
      updatedAt: stamp,
    });
    await saveDataset(user.uid, asset);
    return NextResponse.json({ dataset: asset, requestId }, { status: 201, headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Import du dataset impossible"), requestId },
      { status: errorStatus(error, 400), headers: { "x-request-id": requestId } },
    );
  }
}
