import "server-only";

import { gunzipSync } from "node:zlib";

import { assertHubRef, HubError, type HubProvider } from "./common";

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
export { estFichierParquet, lignesDepuisParquet, normaliserValeurParquet } from "./parquet";
export type { ResultatParquet } from "./parquet";
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

export { hfToken, searchHuggingFaceDatasets, inspectHuggingFaceDataset, huggingFaceFileUrl, lireLignesHuggingFace } from "./huggingface";
export { kaggleToken, searchKaggleDatasets, inspectKaggleDataset, downloadKaggleFile } from "./kaggle";

import { searchHuggingFaceDatasets, inspectHuggingFaceDataset, huggingFaceFileUrl, lireLignesHuggingFace } from "./huggingface";
import { searchKaggleDatasets, inspectKaggleDataset } from "./kaggle";
import { hubDownloadFile } from "./common";
import { hfToken } from "./huggingface";
import { kaggleToken, downloadKaggleFile } from "./kaggle";

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
  partiel = false,
): Promise<{ buffer: Buffer; contentType: string; tronque?: boolean }> {
  const safeRef = assertHubRef(provider, ref);
  if (provider === "kaggle") return downloadKaggleFile(safeRef, fileName, maxBytes, partiel);
  const headers: Record<string, string> = {};
  const token = hfToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const resultat = await hubDownloadFile(huggingFaceFileUrl(safeRef, fileName), { headers }, maxBytes, undefined, { partiel });
  // Transparence .gz : les fichiers compressés des hubs (.jsonl.gz, .csv.gz…)
  // sont décompressés ici, DANS le plafond (la sortie est bornée par la même
  // limite que le téléchargement — jamais de pic mémoire non borné).
  if (/\.gz$/i.test(fileName)) {
    const decompresse = gunzipBorne(resultat.buffer, maxBytes);
    return { ...resultat, buffer: decompresse, tronque: true };
  }
  return resultat;
}

/** Décompression gzip BORNÉE (sortie plafonnée — tolère une sortie tronquée). */
function gunzipBorne(buffer: Buffer, maxBytes: number): Buffer {
  try {
    const decompresse = gunzipSync(buffer);
    // La sortie doit rester dans le plafond : on coupe à maxBytes.
    return decompresse.byteLength > maxBytes ? decompresse.subarray(0, maxBytes) : decompresse;
  } catch {
    // Fichier .gz illisible (corrompu, partiel sur binaire compressé…) :
    // on renvoie le tampon brut — le parsing lèvera une erreur lisible.
    return buffer;
  }
}

/** État de configuration des connecteurs (affiché côté UI, sans secret). */
export function hubIntegrationStatus(): Array<{ provider: HubProvider; configured: boolean }> {
  return [
    { provider: "huggingface", configured: true },
    { provider: "kaggle", configured: kaggleToken() !== null },
  ];
}

/** Lit jusqu'à maxLignes lignes RÉELLES d'un dataset via l'API de paging du
 *  hub (datasets-server /rows pour Hugging Face — repli honnête quand un
 *  fichier, typiquement .parquet trop grand pour le plafond, ne peut pas
 *  être téléchargé et parsé directement). Kaggle n'expose pas
 *  d'équivalent : HubError « config » honnête. */
export async function lireLignesHub(
  provider: HubProvider,
  ref: string,
  maxLignes: number,
): Promise<Array<Record<string, unknown>>> {
  const safeRef = assertHubRef(provider, ref);
  if (provider === "kaggle") {
    throw new HubError("config", "Paging de lignes non disponible pour Kaggle (API sans équivalent /rows).");
  }
  return lireLignesHuggingFace(safeRef, maxLignes);
}
