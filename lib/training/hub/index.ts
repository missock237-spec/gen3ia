import "server-only";

import { assertHubRef, type HubProvider } from "./common";

export {
  HUB_PROVIDERS,
  HUB_DATASET_FILE_RE,
  HubError,
  hubErrorStatus,
  assertHubRef,
  assertHubQuery,
  assertHubFileName,
  hubDatasetSummarySchema,
  hubDatasetDetailSchema,
  hubFileSchema,
  selectFilesForImport,
  parseCsvPreview,
  csvPreviewToRows,
  parseCsvLine,
  truncatePreviewRows,
  encodeHubPath,
} from "./common";
export type {
  HubProvider,
  HubDatasetSummary,
  HubDatasetDetail,
  HubFile,
  HubFileSelection,
  HubImportCaps,
  HubErrorKind,
  CsvPreview,
} from "./common";

export { hfToken, searchHuggingFaceDatasets, inspectHuggingFaceDataset, huggingFaceFileUrl } from "./huggingface";
export { kaggleToken, searchKaggleDatasets, inspectKaggleDataset, downloadKaggleFile } from "./kaggle";

import { searchHuggingFaceDatasets, inspectHuggingFaceDataset, huggingFaceFileUrl } from "./huggingface";
import { searchKaggleDatasets, inspectKaggleDataset, downloadKaggleFile } from "./kaggle";
import { hubDownloadFile } from "./common";
import { hfToken } from "./huggingface";
import { kaggleToken } from "./kaggle";

/* ------------------------------------------------------------------ */
/* Façade unifiée — dispatch par fournisseur, contrat unique            */
/* ------------------------------------------------------------------ */

/** Recherche multi-hubs : l'absence de token Kaggle est signalée sans stopper HF. */
export async function searchHubDatasets(
  provider: HubProvider,
  query: string,
  limit: number,
): Promise<ReturnType<typeof searchHuggingFaceDatasets>> {
  if (provider === "kaggle") return searchKaggleDatasets(query, limit);
  return searchHuggingFaceDatasets(query, limit);
}

export async function inspectHubDataset(provider: HubProvider, ref: string): Promise<ReturnType<typeof inspectHuggingFaceDataset>> {
  if (provider === "kaggle") return inspectKaggleDataset(assertHubRef("kaggle", ref));
  return inspectHuggingFaceDataset(assertHubRef("huggingface", ref));
}

/** Télécharge un fichier d'un hub avec plafond strict, via son connecteur. */
export async function downloadHubFile(
  provider: HubProvider,
  ref: string,
  fileName: string,
  maxBytes: number,
): Promise<{ buffer: Buffer; contentType: string }> {
  const safeRef = assertHubRef(provider, ref);
  if (provider === "kaggle") return downloadKaggleFile(safeRef, fileName, maxBytes);
  const headers: Record<string, string> = {};
  const token = hfToken();
  if (token) headers.authorization = `Bearer ${token}`;
  return hubDownloadFile(huggingFaceFileUrl(safeRef, fileName), { headers }, maxBytes);
}

/** État de configuration des connecteurs (affiché côté UI, sans secret). */
export function hubIntegrationStatus(): Array<{ provider: HubProvider; configured: boolean }> {
  return [
    { provider: "huggingface", configured: true },
    { provider: "kaggle", configured: kaggleToken() !== null },
  ];
}
