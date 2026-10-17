import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { putObject } from "@/lib/storage/r2";
import { newUlid, userDir } from "@/lib/storage/user-data-store";

import { assertAssetQuota, assertUploadSize } from "@/lib/training/quotas";
import { getProject, listModels, saveModel } from "@/lib/training/repository";
import { validateModelFile } from "@/lib/training/validation/model-files";
import { modelAssetSchema } from "@/lib/training/types";
import { BASE_MODELS } from "@/lib/training/catalog";

/** GET /api/training/projects/[id]/models — liste des assets modèle du projet. */
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
    const models = await listModels(user.uid, id);
    return NextResponse.json({ models, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Liste des modèles indisponible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}

/**
 * POST /api/training/projects/[id]/models
 *  - multipart/form-data : fichier modèle (.safetensors/.gguf/.zip) + name ;
 *  - application/json    : { catalogId, name } pour référencer un modèle de base du catalogue.
 *
 * Le fichier est VALIDÉ AVANT tout stockage : formats pickle refusés,
 * headers vérifiés, archives inspectées (spec §11).
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
    await assertAssetQuota("models", user.uid, id);

    const contentType = request.headers.get("content-type") ?? "";
    const stamp = new Date().toISOString();

    /* -------------------- Référence catalogue (JSON) -------------------- */
    if (contentType.includes("application/json")) {
      const body = (await request.json().catch(() => null)) as { catalogId?: unknown; name?: unknown } | null;
      const catalogId = typeof body?.catalogId === "string" ? body.catalogId : "";
      const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 180) : "";
      const entry = BASE_MODELS.find((m) => m.id === catalogId);
      if (!entry) {
        return NextResponse.json(
          { error: "Modèle de base inconnu du catalogue.", requestId },
          { status: 400, headers: { "x-request-id": requestId } },
        );
      }
      const asset = modelAssetSchema.parse({
        id: newUlid(),
        projectId: id,
        ownerId: user.uid,
        name: name || entry.name,
        source: "catalog",
        catalogId: entry.id,
        sizeBytes: 0,
        status: "valid",
        findings: [
          {
            level: "info",
            code: "catalog-reference",
            message: `Référence catalogue : ${entry.id} — aucun poids téléchargé, le worker GPU récupérera le modèle depuis le dépôt officiel.`,
          },
        ],
        metadata: { params: entry.params, minVramGb: entry.minVramGb, recommendedFor: entry.recommendedFor },
        createdAt: stamp,
        updatedAt: stamp,
      });
      await saveModel(user.uid, asset);
      return NextResponse.json({ model: asset, requestId }, { status: 201, headers: { "x-request-id": requestId } });
    }

    /* -------------------- Téléversement (multipart) --------------------- */
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    const nameField = form?.get("name");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Fichier manquant : joignez le modèle (champ « file »).", requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }
    const name = (typeof nameField === "string" && nameField.trim() ? nameField.trim() : file.name).slice(0, 180);
    const buffer = Buffer.from(await file.arrayBuffer());
    assertUploadSize(buffer.byteLength, "Modèle");

    const report = await validateModelFile(name, buffer, project.family);

    if (report.status === "rejected") {
      // Refusé : RIEN n'est stocké — ni le fichier, ni le document.
      return NextResponse.json(
        { error: "Fichier modèle refusé après validation.", findings: report.findings, requestId },
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

    const asset = modelAssetSchema.parse({
      id: assetId,
      projectId: id,
      ownerId: user.uid,
      name,
      source: "upload",
      format: report.format,
      storageKey,
      sizeBytes: buffer.byteLength,
      sha256: report.sha256,
      status: report.status,
      findings: report.findings,
      metadata: report.metadata,
      createdAt: stamp,
      updatedAt: stamp,
    });
    await saveModel(user.uid, asset);
    return NextResponse.json({ model: asset, requestId }, { status: 201, headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Import du modèle impossible"), requestId },
      { status: errorStatus(error, 400), headers: { "x-request-id": requestId } },
    );
  }
}
