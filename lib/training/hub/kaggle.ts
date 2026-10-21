import "server-only";

import {
  assertHubFileName,
  HubError,
  hubDatasetDetailSchema,
  hubDatasetSummarySchema,
  hubFetchJson,
  HUB_DATASET_FILE_RE,
  csvPreviewToRows,
  parseCsvPreview,
  truncatePreviewRows,
  type HubDatasetDetail,
  type HubDatasetSummary,
  type HubProvider,
} from "./common";

/* ------------------------------------------------------------------ */
/* Connecteur Kaggle (v1.1) — API v1, jeton KGAT (Bearer)               */
/*                                                                    */
/* Sources RÉELLES :                                                   */
/*  - GET /api/v1/datasets/list?search=…      (recherche)              */
/*  - GET /api/v1/datasets/view/{owner}/{slug} (métadonnées, licence)    */
/*  - GET /api/v1/datasets/list/{owner}/{slug} (fichiers + tailles)     */
/*  - GET /api/v1/datasets/download/{owner}/{slug}/{fichier}            */
/*      → téléchargement d'un fichier précis (aperçu / import)          */
/* Le jeton est lu UNIQUEMENT côté serveur (KAGGLE_API_TOKEN) et       */
/* n'apparaît jamais dans une réponse, un log ou le client.            */
/* ------------------------------------------------------------------ */

const KAGGLE_API = "https://www.kaggle.com/api/v1";

/** Taille maximale d'un fichier utilisé pour l'aperçu (2 Mo). */
const KAGGLE_PREVIEW_FILE_CAP_BYTES = 2 * 1024 * 1024;

/** Jeton Kaggle (nouveau format KGAT_…, authentification Bearer). */
export function kaggleToken(): string | null {
  const token = process.env.KAGGLE_API_TOKEN?.trim() || process.env.KAGGLE_KEY?.trim() || "";
  return token.length > 0 ? token : null;
}

function kaggleHeaders(): Record<string, string> {
  const token = kaggleToken();
  if (!token) {
    throw new HubError(
      "config",
      "Intégration Kaggle non configurée : définissez KAGGLE_API_TOKEN côté serveur (jeton Kaggle, format KGAT_…).",
    );
  }
  return { authorization: `Bearer ${token}` };
}

/* ------------------------------ Recherche ------------------------- */

interface KaggleDatasetListItem {
  ref?: string;
  title?: string;
  subtitle?: string;
  totalBytes?: number;
  size?: unknown;
  licenseName?: string;
  voteCount?: number;
  votes?: number;
  downloadCount?: number;
  totalDownloads?: number;
  lastUpdated?: string;
}

function toIntOrZero(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

export async function searchKaggleDatasets(query: string, limit: number): Promise<HubDatasetSummary[]> {
  const bounded = Math.min(Math.max(limit, 1), 30);
  const url = `${KAGGLE_API}/datasets/list?search=${encodeURIComponent(query)}&pageSize=${bounded}`;
  const items = await hubFetchJson<KaggleDatasetListItem[]>(url, { headers: kaggleHeaders() });
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => typeof item.ref === "string" && item.ref.includes("/"))
    .slice(0, bounded)
    .map((item) =>
      hubDatasetSummarySchema.parse({
        provider: "kaggle" as HubProvider,
        ref: String(item.ref),
        name: String(item.title ?? item.ref).slice(0, 240),
        description: typeof item.subtitle === "string" ? item.subtitle.slice(0, 500) : "",
        sizeBytes: toIntOrZero(item.totalBytes ?? item.size) || null,
        downloads: toIntOrZero(item.downloadCount ?? item.totalDownloads) || null,
        likes: toIntOrZero(item.voteCount ?? item.votes) || null,
        license: typeof item.licenseName === "string" ? item.licenseName.slice(0, 80) : null,
        lastModified: typeof item.lastUpdated === "string" ? item.lastUpdated.slice(0, 40) : null,
        tags: [],
      }),
    );
}

/* ----------------------------- Inspection ------------------------- */

interface KaggleDatasetView {
  ref?: string;
  title?: string;
  subtitle?: string;
  licenseName?: string;
  totalBytes?: number;
  size?: unknown;
  owner?: { name?: string };
}

interface KaggleDatasetFile {
  name?: string;
  fileName?: string;
  totalBytes?: number;
  size?: unknown;
}

export async function inspectKaggleDataset(ref: string): Promise<HubDatasetDetail> {
  const [owner, slug] = ref.split("/");
  const headers = kaggleHeaders();

  const view = await hubFetchJson<KaggleDatasetView>(
    `${KAGGLE_API}/datasets/view/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`,
    { headers },
  );

  const filesRaw = await hubFetchJson<KaggleDatasetFile[]>(
    `${KAGGLE_API}/datasets/list/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`,
    { headers },
  );

  const files = (Array.isArray(filesRaw) ? filesRaw : [])
    .map((file) => {
      const name = typeof file.name === "string" ? file.name : typeof file.fileName === "string" ? file.fileName : "";
      const sizeBytes = toIntOrZero(file.totalBytes ?? file.size);
      return {
        name: name.slice(0, 300),
        sizeBytes,
        downloadable: HUB_DATASET_FILE_RE.test(name),
      };
    })
    .filter((file) => file.name.length > 0)
    .slice(0, 200);

  // Aperçu : le plus PETIT fichier ingérable sous 2 Mo (téléchargement réel).
  let previewRows: Array<Record<string, unknown>> = [];
  let columns: string[] = [];
  const notes: string[] = [
    "Kaggle n'expose pas les splits d'un jeu de données : assignez chaque fichier importé à train, validation ou test après l'import.",
  ];
  const previewCandidate = files
    .filter((file) => file.downloadable && file.sizeBytes > 0 && file.sizeBytes <= KAGGLE_PREVIEW_FILE_CAP_BYTES)
    .sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
  if (previewCandidate) {
    try {
      const { buffer } = await downloadKaggleFile(ref, previewCandidate.name, KAGGLE_PREVIEW_FILE_CAP_BYTES);
      const text = buffer.toString("utf8");
      if (/\.csv$/i.test(previewCandidate.name)) {
        const preview = parseCsvPreview(text, 10, 20);
        columns = preview.header;
        previewRows = truncatePreviewRows(csvPreviewToRows(preview));
      } else if (/\.jsonl$/i.test(previewCandidate.name)) {
        const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 10);
        previewRows = truncatePreviewRows(
          lines
            .map((line) => {
              try {
                return JSON.parse(line) as Record<string, unknown>;
              } catch {
                return null;
              }
            })
            .filter((row): row is Record<string, unknown> => row !== null),
        );
        columns = Object.keys(previewRows[0] ?? {}).slice(0, 30);
      } else if (/\.json$/i.test(previewCandidate.name)) {
        const parsed = JSON.parse(text) as unknown;
        const rows = Array.isArray(parsed)
          ? (parsed.filter((item) => item !== null && typeof item === "object") as Array<Record<string, unknown>>)
          : [];
        previewRows = truncatePreviewRows(rows);
        columns = Object.keys(rows[0] ?? {}).slice(0, 30);
      } else {
        // .txt : lignes brutes présentées en colonne unique.
        const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 10);
        previewRows = lines.map((line) => ({ texte: line.slice(0, 200) }));
        columns = ["texte"];
      }
      notes.push(`Aperçu extrait du fichier « ${previewCandidate.name} » (téléchargé intégralement, ${previewRows.length} ligne(s) affichée(s)).`);
    } catch {
      notes.push("Aperçu indisponible : le fichier le plus léger n'a pas pu être téléchargé.");
    }
  } else {
    notes.push("Aucun fichier léger ingérable (≤ 2 Mo) pour l'aperçu : aucun échantillon affiché.");
  }

  return hubDatasetDetailSchema.parse({
    provider: "kaggle",
    ref: String(view.ref ?? ref),
    name: String(view.title ?? slug).slice(0, 240),
    description: typeof view.subtitle === "string" ? view.subtitle.slice(0, 500) : "",
    sizeBytes: toIntOrZero(view.totalBytes ?? view.size) || null,
    downloads: null,
    likes: null,
    license: typeof view.licenseName === "string" ? view.licenseName.slice(0, 80) : null,
    lastModified: null,
    tags: [],
    files,
    splits: [], // Kaggle ne déclare pas de splits — note explicite ci-dessus.
    columns,
    previewRows,
    notes,
    inspectedAt: new Date().toISOString(),
  });
}

/* --------------------------- Téléchargement ----------------------- */

/** Télécharge un fichier précis d'un dataset Kaggle (plafond appliqué).
 *  `partiel` : les grands fichiers sont tronqués au plafond au lieu d'être
 *  refusés (auto-apprentissage). */
export async function downloadKaggleFile(
  ref: string,
  fileName: string,
  maxBytes: number,
  partiel = false,
): Promise<{ buffer: Buffer; contentType: string; tronque?: boolean }> {
  const safeName = assertHubFileName(fileName);
  const [owner, slug] = ref.split("/");
  const { hubDownloadFile } = await import("./common");
  const url =
    `${KAGGLE_API}/datasets/download/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}` +
    `/${safeName.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
  return hubDownloadFile(url, { headers: kaggleHeaders() }, maxBytes, undefined, { partiel });
}
