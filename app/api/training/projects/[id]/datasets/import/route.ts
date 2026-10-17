import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { putObject } from "@/lib/storage/r2";
import { newUlid, userDir } from "@/lib/storage/user-data-store";

import {
  downloadHubFile,
  HubError,
  hubErrorStatus,
  inspectHubDataset,
  selectFilesForImport,
} from "@/lib/training/hub";
import { ipFromRequest, recordTrainingAudit } from "@/lib/training/audit";
import { getProject, listDatasets, saveDataset } from "@/lib/training/repository";
import { assertAssetQuota, assertStorageQuota, assertUploadSize, trainingQuotas } from "@/lib/training/quotas";
import { validateDatasetFile } from "@/lib/training/validation/dataset-files";
import { datasetAssetSchema, datasetSplitSchema } from "@/lib/training/types";

export const maxDuration = 300;

const importSchema = z.object({
  provider: z.enum(["huggingface", "kaggle"]),
  ref: z.string().min(3).max(260),
  split: datasetSplitSchema.default("unassigned"),
  /** Sélection explicite de fichiers (optionnel — sinon sélection automatique). */
  files: z.array(z.string().min(1).max(300)).max(20).optional(),
});

/**
 * POST /api/training/projects/[id]/datasets/import
 *
 * Import RÉEL d'un dataset depuis Hugging Face ou Kaggle (v1.1) :
 *  1. inspection du hub (fichiers, splits, licence, échantillon) ;
 *  2. sélection des fichiers ingérables sous les plafonds serveur
 *     (par fichier, total, nombre) — les exclusions sont EXPLIQUÉES ;
 *  3. téléchargement effectif de chaque fichier (plafond réappliqué) ;
 *  4. validation par le MÊME pipeline que les téléversements (stats,
 *     doublons, PII) puis stockage R2 ;
 *  5. journal d'audit.
 *
 * Honnêteté : si AUCUN fichier ne peut être importé, la réponse est 422 avec
 * les raisons — jamais un asset factice. Les métadonnées d'origine (lignes
 * totales déclarées par le hub) sont conservées même quand seuls certains
 * fichiers ont été téléchargés.
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
      return NextResponse.json(
        { error: "Projet introuvable.", requestId },
        { status: 404, headers: { "x-request-id": requestId } },
      );
    }

    const limit = await rateLimitDistributed(`training:hub-import:${user.uid}`, {
      limit: 6,
      windowMs: 5 * 60_000,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Trop d'imports rapprochés : patientez quelques minutes.", requestId },
        { status: 429, headers: { "x-request-id": requestId } },
      );
    }

    const parsedBody = importSchema.safeParse(await request.json().catch(() => null));
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Requête d'import invalide (provider, ref, split, files).", requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }
    const { provider, ref, split } = parsedBody.data;

    await assertAssetQuota("datasets", user.uid, id);
    const quotas = trainingQuotas();
    const existing = await listDatasets(user.uid, id);
    const roomLeft = Math.max(0, quotas.maxDatasetsPerProject - existing.length);
    if (roomLeft === 0) {
      return NextResponse.json(
        {
          error: `Quota atteint : ${quotas.maxDatasetsPerProject} datasets maximum par projet.`,
          requestId,
        },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }

    // 1. Inspection fraîche du hub (métadonnées réelles).
    const detail = await inspectHubDataset(provider, ref);

    // 2. Sélection sous plafonds — les exclusions portent leur raison.
    const caps = {
      perFileBytes: quotas.maxUploadBytes,
      totalBytes: quotas.maxHubImportBytes,
      maxFiles: Math.min(roomLeft, 10),
    };
    const selection = selectFilesForImport(detail, caps, parsedBody.data.files);
    if (selection.selected.length === 0) {
      return NextResponse.json(
        {
          error:
            "Aucun fichier de ce jeu de données n'est importable (formats .csv/.json/.jsonl/.txt uniquement, plafonds de taille). Détails dans « skipped ».",
          skipped: selection.skipped,
          notes: detail.notes,
          requestId,
        },
        { status: 422, headers: { "x-request-id": requestId } },
      );
    }

    // 3-4. Téléchargement réel + validation par le pipeline commun.
    const imported: Array<{ id: string; name: string; rows: number }> = [];
    const skipped: Array<{ name: string; reason: string }> = [...selection.skipped];
    const totalRowsDeclared =
      detail.splits.length > 0
        ? detail.splits.reduce((total, splitInfo) => total + (splitInfo.rows ?? 0), 0)
        : null;

    for (const file of selection.selected) {
      try {
        const { buffer, contentType } = await downloadHubFile(provider, ref, file.name, caps.perFileBytes);
        assertUploadSize(buffer.byteLength, `Fichier ${file.name}`);
        await assertStorageQuota(user.uid, buffer.byteLength);

        const report = validateDatasetFile(file.name, buffer);
        if (report.status === "rejected") {
          skipped.push({
            name: file.name,
            reason: report.findings.map((finding) => finding.message).join(" ") || "Contenu refusé par la validation.",
          });
          continue;
        }

        const assetId = newUlid();
        const storageKey = `${userDir(user.uid, "training-files", id)}/${assetId}`;
        await putObject({
          key: storageKey,
          body: buffer,
          contentType,
          contentLength: buffer.byteLength,
        });

        const stamp = new Date().toISOString();
        const asset = datasetAssetSchema.parse({
          id: assetId,
          projectId: id,
          ownerId: user.uid,
          name: (file.name.split("/").pop() ?? file.name).slice(0, 180),
          format: report.format,
          source: provider,
          hubRef: ref,
          originMetadata: {
            provider,
            hubRef: ref,
            totalRows: totalRowsDeclared,
            splits: detail.splits,
            license: detail.license,
            importedFiles: selection.selected.length,
            skippedFiles: selection.skipped.length,
            inspectedAt: detail.inspectedAt,
          },
          previewRows: detail.previewRows,
          storageKey,
          sizeBytes: buffer.byteLength,
          sha256: report.sha256,
          split,
          stats: report.stats,
          status: report.status,
          findings: [
            ...report.findings,
            {
              level: "info" as const,
              code: "hub-import",
              message: `Importé depuis ${provider === "huggingface" ? "Hugging Face" : "Kaggle"} (${ref}).`,
            },
          ],
          createdAt: stamp,
          updatedAt: stamp,
        });
        await saveDataset(user.uid, asset);
        imported.push({ id: asset.id, name: asset.name, rows: asset.stats.rows });
      } catch (error) {
        skipped.push({
          name: file.name,
          reason: error instanceof Error ? error.message : "Téléchargement impossible.",
        });
      }
    }

    // 5. Audit (fire-and-forget : jamais bloquant pour l'action).
    void recordTrainingAudit({
      uid: user.uid,
      action: "dataset.imported",
      entityType: "dataset",
      entityId: imported[0]?.id ?? ref,
      projectId: id,
      ip: ipFromRequest(request),
      details: {
        provider,
        ref,
        importedFiles: imported.length,
        skippedFiles: skipped.length,
        declaredTotalRows: totalRowsDeclared,
      },
    }).catch(() => undefined);

    if (imported.length === 0) {
      return NextResponse.json(
        {
          error: "Aucun fichier n'a pu être importé : chaque téléchargement a été refusé (détails dans « skipped »).",
          skipped,
          notes: detail.notes,
          requestId,
        },
        { status: 422, headers: { "x-request-id": requestId } },
      );
    }

    return NextResponse.json(
      {
        datasets: imported,
        skipped,
        origin: {
          provider,
          ref,
          declaredTotalRows: totalRowsDeclared,
          splits: detail.splits,
          license: detail.license,
          notes: detail.notes,
        },
        requestId,
      },
      { status: 201, headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    // Erreurs hub → statuts typés (400/404/502/503) ; erreurs de quota ou
    // de validation → 400 lisible ; le reste suit errorStatus.
    const fallback = error instanceof HubError ? hubErrorStatus(error) : 400;
    return NextResponse.json(
      { ...errorBody(error, "Import depuis le hub impossible."), requestId },
      { status: errorStatus(error, fallback), headers: { "x-request-id": requestId } },
    );
  }
}
