import "server-only";

import {
  hubDatasetDetailSchema,
  hubDatasetSummarySchema,
  hubFetchJson,
  HubError,
  HUB_DATASET_FILE_RE,
  truncatePreviewRows,
  type HubDatasetDetail,
  type HubDatasetSummary,
  type HubProvider,
} from "./common";

/* ------------------------------------------------------------------ */
/* Connecteur Hugging Face (v1.1)                                       */
/*                                                                    */
/* Sources RÉELLES :                                                   */
/*  - https://huggingface.co/api/datasets?search=…   (recherche)       */
/*  - https://huggingface.co/api/datasets/{id}       (fichiers, card)   */
/*  - https://datasets-server.huggingface.co/info?dataset=…            */
/*      → splits + num_examples (déclarés par le hub)                   */
/*  - https://datasets-server.huggingface.co/first-rows?…              */
/*      → échantillon de lignes réelles                                */
/* Ce que l'API ne fournit pas reste null + note (taille exacte des     */
/* fichiers : non exposée par l'API de listing).                      */
/* ------------------------------------------------------------------ */

const HF_API = "https://huggingface.co";
const HF_DATASETS_SERVER = "https://datasets-server.huggingface.co";

/** Token HF optionnel (recherche publique sans token, quotas plus larges avec). */
export function hfToken(): string | null {
  const token = process.env.HF_TOKEN?.trim() || process.env.HUGGINGFACE_TOKEN?.trim() || "";
  return token.length > 0 ? token : null;
}

function hfHeaders(): Record<string, string> {
  const token = hfToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/* ------------------------------ Recherche ------------------------- */

interface HfDatasetListItem {
  id?: string;
  likes?: number;
  downloads?: number;
  tags?: unknown;
  lastModified?: string;
  private?: boolean;
}

/** Extrait la licence des tags du hub (`license:xxx`). */
function licenseFromTags(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    if (typeof tag === "string" && tag.startsWith("license:")) {
      return tag.slice("license:".length).slice(0, 80);
    }
  }
  return null;
}

export async function searchHuggingFaceDatasets(query: string, limit: number): Promise<HubDatasetSummary[]> {
  const url =
    `${HF_API}/api/datasets?search=${encodeURIComponent(query)}` +
    `&limit=${Math.min(Math.max(limit, 1), 30)}&sort=downloads&direction=-1`;
  const items = await hubFetchJson<HfDatasetListItem[]>(url, { headers: hfHeaders() });
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => typeof item.id === "string" && item.id.includes("/") && !item.private)
    .slice(0, Math.min(Math.max(limit, 1), 30))
    .map((item) =>
      hubDatasetSummarySchema.parse({
        provider: "huggingface" as HubProvider,
        ref: String(item.id),
        name: String(item.id).split("/").pop() ?? String(item.id),
        description: "",
        sizeBytes: null, // non exposé par l'API de listing — aucune invention
        downloads: typeof item.downloads === "number" && item.downloads >= 0 ? item.downloads : null,
        likes: typeof item.likes === "number" && item.likes >= 0 ? item.likes : null,
        license: licenseFromTags(item.tags),
        lastModified: typeof item.lastModified === "string" ? item.lastModified.slice(0, 40) : null,
        tags: Array.isArray(item.tags)
          ? item.tags.filter((tag): tag is string => typeof tag === "string" && !tag.startsWith("license:")).slice(0, 12)
          : [],
      }),
    );
}

/* ----------------------------- Inspection ------------------------- */

interface HfRepoFile {
  rfilename?: string;
}

interface HfDatasetInfo {
  id?: string;
  likes?: number;
  downloads?: number;
  tags?: unknown;
  lastModified?: string;
  siblings?: HfRepoFile[];
  cardData?: {
    license?: unknown;
    language?: unknown;
    size_categories?: unknown;
    [key: string]: unknown;
  };
}

interface DsServerSplit {
  name?: unknown;
  num_examples?: unknown;
}

interface DsServerConfig {
  config_name?: unknown;
  splits?: DsServerSplit[];
  features?: unknown;
}

interface DsServerInfo {
  dataset_info?:
    | { configs?: DsServerConfig[] }
    | { splits?: DsServerSplit[] | Record<string, { num_examples?: unknown }> };
  error?: unknown;
}

interface DsServerFirstRows {
  features?: Array<{ name?: unknown }>;
  rows?: Array<{ row?: Record<string, unknown> }>;
}

/** Choisit la config d'un dataset depuis /info — gère les DEUX formes de la
 *  réponse : { configs: […] } (multi-configs) ou directement { splits: … }
 *  (config unique), splits étant un tableau ou un dictionnaire. */
function choisirConfigDsServer(info: DsServerInfo): DsServerConfig | null {
  const infoBrute = info.dataset_info;
  if (!infoBrute) return null;
  if ("configs" in infoBrute && Array.isArray(infoBrute.configs)) {
    return infoBrute.configs.find((config) => config.config_name === "default") ?? infoBrute.configs[0] ?? null;
  }
  if ("splits" in infoBrute && infoBrute.splits) {
    const splits = Array.isArray(infoBrute.splits)
      ? infoBrute.splits
      : Object.entries(infoBrute.splits).map(([name, valeur]) => ({
          name,
          num_examples: (valeur as { num_examples?: unknown })?.num_examples,
        }));
    return { config_name: "default", splits };
  }
  return null;
}

function featuresToColumns(features: unknown, max = 30): string[] {
  const columns: string[] = [];
  if (Array.isArray(features)) {
    for (const feature of features) {
      if (feature && typeof feature === "object" && "name" in feature) {
        const name = (feature as { name?: unknown }).name;
        if (typeof name === "string") columns.push(name.slice(0, 80));
      }
      if (columns.length >= max) break;
    }
  } else if (features !== null && typeof features === "object") {
    for (const key of Object.keys(features as Record<string, unknown>)) {
      columns.push(key.slice(0, 80));
      if (columns.length >= max) break;
    }
  }
  return columns;
}

export async function inspectHuggingFaceDataset(ref: string): Promise<HubDatasetDetail> {
  const [owner, name] = ref.split("/");
  const infoUrl = `${HF_API}/api/datasets/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const info = await hubFetchJson<HfDatasetInfo>(infoUrl, { headers: hfHeaders() });

  const notes: string[] = [];
  const files = (info.siblings ?? [])
    .map((sibling) => (typeof sibling.rfilename === "string" ? sibling.rfilename : ""))
    .filter((filename) => filename.length > 0 && !filename.startsWith("."))
    .slice(0, 200)
    .map((filename) => ({
      name: filename.slice(0, 300),
      sizeBytes: 0, // l'API de listing n'expose pas la taille des fichiers
      downloadable: HUB_DATASET_FILE_RE.test(filename),
    }));
  notes.push(
    "Taille exacte des fichiers non exposée par l'API Hugging Face : le plafond par fichier sera appliqué au téléchargement.",
  );

  // Splits déclarés via datasets-server (peut échouer pour les dépôts privés/gated).
  let splits: HubDatasetDetail["splits"] = [];
  let columns: string[] = [];
  let previewRows: Array<Record<string, unknown>> = [];
  try {
    const serverInfo = await hubFetchJson<DsServerInfo>(
      `${HF_DATASETS_SERVER}/info?dataset=${encodeURIComponent(ref)}`,
      { headers: hfHeaders() },
    );
    const chosen = choisirConfigDsServer(serverInfo);
    if (chosen?.splits) {
      splits = chosen.splits
        .slice(0, 20)
        .map((split) => ({
          name: typeof split.name === "string" ? split.name.slice(0, 60) : "?",
          rows: typeof split.num_examples === "number" && split.num_examples >= 0 ? split.num_examples : null,
        }));
      columns = featuresToColumns(chosen.features);
    }
    const firstSplit = splits[0]?.name;
    if (firstSplit) {
      const configName = typeof chosen?.config_name === "string" ? chosen.config_name : "default";
      const firstRows = await hubFetchJson<DsServerFirstRows>(
        `${HF_DATASETS_SERVER}/first-rows?dataset=${encodeURIComponent(ref)}` +
          `&config=${encodeURIComponent(configName)}&split=${encodeURIComponent(firstSplit)}`,
        { headers: hfHeaders() },
      );
      if (Array.isArray(firstRows.features) && columns.length === 0) {
        columns = firstRows.features
          .map((feature) => (typeof feature?.name === "string" ? feature.name.slice(0, 80) : ""))
          .filter(Boolean)
          .slice(0, 30);
      }
      previewRows = truncatePreviewRows(
        (firstRows.rows ?? []).slice(0, 10).map((entry) => entry.row ?? {}),
      );
    }
  } catch {
    notes.push(
      "Splits et aperçu non exposés par datasets-server pour ce dépôt (privé, restreint ou format non encore converti).",
    );
  }

  const license =
    typeof info.cardData?.license === "string"
      ? info.cardData.license.slice(0, 80)
      : licenseFromTags(info.tags);

  return hubDatasetDetailSchema.parse({
    provider: "huggingface",
    ref: String(info.id ?? ref),
    name: name.slice(0, 240),
    description:
      typeof info.cardData?.language === "string"
        ? `Langue déclarée : ${info.cardData.language.slice(0, 60)}.`
        : "",
    sizeBytes: null,
    downloads: typeof info.downloads === "number" && info.downloads >= 0 ? info.downloads : null,
    likes: typeof info.likes === "number" && info.likes >= 0 ? info.likes : null,
    license,
    lastModified: typeof info.lastModified === "string" ? info.lastModified.slice(0, 40) : null,
    tags: Array.isArray(info.tags)
      ? info.tags.filter((tag): tag is string => typeof tag === "string" && !tag.startsWith("license:")).slice(0, 12)
      : [],
    files,
    splits,
    columns,
    previewRows,
    notes,
    inspectedAt: new Date().toISOString(),
  });
}

/** URL de téléchargement d'un fichier de dataset HF (redirect → CDN). */
export function huggingFaceFileUrl(ref: string, fileName: string): string {
  const [owner, name] = ref.split("/");
  return `${HF_API}/datasets/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/resolve/main/${fileName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

/* ------------------------------------------------------------------ */
/* LIGNES VIA datasets-server (/rows) — les datasets PARQUET-ONLY       */
/*                                                                      */
/* La majorité des datasets HF ne livrent que des fichiers .parquet     */
/* (non ingérables par un parsing fichier). Le serveur de datasets de   */
/* HF expose néanmoins leurs lignes DÉJÀ CONVERTIES :                   */
/*   GET /info?dataset=…  → configs + splits                            */
/*   GET /rows?dataset=…&config=…&split=…&offset=…&length=100            */
/*        → { features, rows: [{ row: { colonne: valeur } }] }          */
/* C'est du paging borné (pas de téléchargement de fichier) : chaque    */
/* réponse est un petit JSON. Honnêteté : si le serveur ne couvre pas   */
/* le dataset (privé, exotique), l'échec est retourné tel quel.         */
/* ------------------------------------------------------------------ */

/** Pages maximales de /rows par dataset (100 lignes/page → 500 lignes max). */
const LIGNES_MAX_PAGES = 5;

/** Lit jusqu'à maxLignes lignes réelles d'un dataset via datasets-server. */
export async function lireLignesHuggingFace(
  ref: string,
  maxLignes: number,
): Promise<Array<Record<string, unknown>>> {
  const info = await hubFetchJson<DsServerInfo>(
    `${HF_DATASETS_SERVER}/info?dataset=${encodeURIComponent(ref)}`,
    { headers: hfHeaders() },
  );
  // La sélection de config gère les DEUX formes de /info (configs directes
  // ou splits directs) — voir choisirConfigDsServer.
  const choisi = choisirConfigDsServer(info);
  const split = choisi?.splits?.[0]?.name;
  if (typeof split !== "string" || split.length === 0) {
    throw new HubError("not-found", "Aucun split exposé par datasets-server pour ce dataset.");
  }
  const config = typeof choisi?.config_name === "string" ? choisi.config_name : "default";

  const lignes: Array<Record<string, unknown>> = [];
  for (let page = 0; page < LIGNES_MAX_PAGES && lignes.length < maxLignes; page += 1) {
    const reponse = await hubFetchJson<DsServerFirstRows>(
      `${HF_DATASETS_SERVER}/rows?dataset=${encodeURIComponent(ref)}` +
        `&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}` +
        `&offset=${page * 100}&length=100`,
      { headers: hfHeaders() },
    );
    const rangées = Array.isArray(reponse.rows) ? reponse.rows : [];
    if (rangées.length === 0) break;
    for (const entree of rangées) {
      if (lignes.length >= maxLignes) break;
      const row = entree?.row;
      if (row !== null && typeof row === "object" && !Array.isArray(row)) {
        lignes.push(row as Record<string, unknown>);
      }
    }
  }
  return lignes;
}
