import "server-only";

import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Connecteurs de hubs de datasets — socle commun (v1.1)                */
/*                                                                    */
/* HONNÊTETÉ : chaque métadonnée affichée ou stockée provient d'un       */
/* appel RÉEL à l'API publique du hub (Hugging Face / Kaggle). Aucune   */
/* taille, aucun nombre de lignes, aucune licence n'est inventé ; ce     */
/* que le hub n'expose pas reste null + une note explicite.             */
/*                                                                    */
/* SÉCURITÉ :                                                          */
/*  - hôtes FIXES (aucune URL fournie par le client n'est résolue :     */
/*    seule la référence propriétaire/jeu est validée puis injectée      */
/*    dans un gabarit — SSRF impossible) ;                             */
/*  - références et requêtes validées par regex stricte ;              */
/*  - timeouts AbortController sur chaque appel ;                      */
/*  - plafond de taille sur les réponses JSON et les fichiers ;        */
/*  - tokens lus UNIQUEMENT côté serveur (process.env), jamais         */
/*    renvoyés au client.                                              */
/* ------------------------------------------------------------------ */

export const HUB_PROVIDERS = ["huggingface", "kaggle"] as const;
export type HubProvider = (typeof HUB_PROVIDERS)[number];

/** Erreurs typées du connecteur — mappées en statuts HTTP par les routes. */
export type HubErrorKind =
  | "invalid" // 400 — entrée utilisateur invalide
  | "config" // 503 — intégration non configurée (token manquant…)
  | "not-found" // 404 — dataset introuvable côté hub
  | "upstream"; // 502 — hub injoignable ou réponse illisible

export class HubError extends Error {
  readonly kind: HubErrorKind;

  constructor(kind: HubErrorKind, message: string) {
    super(message);
    this.name = "HubError";
    this.kind = kind;
  }
}

/** Statut HTTP associé à chaque catégorie d'erreur de hub. */
export function hubErrorStatus(error: unknown): number {
  if (error instanceof HubError) {
    return error.kind === "invalid" ? 400 : error.kind === "not-found" ? 404 : error.kind === "config" ? 503 : 502;
  }
  return 500;
}

/* ------------------------------------------------------------------ */
/* Validation des entrées                                              */
/* ------------------------------------------------------------------ */

/** Référence hub : propriétaire/jeu — segments sûrs, pas de traversée. */
const HUB_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function assertHubRef(provider: HubProvider, ref: string): string {
  const clean = ref.trim();
  if (!HUB_REF_RE.test(clean)) {
    throw new HubError(
      "invalid",
      `Référence ${provider} invalide (« ${clean.slice(0, 60)} ») : format attendu « propriétaire/jeu-de-données ».`,
    );
  }
  return clean;
}

/** Requête de recherche : 1..80 caractères, sans caractères de contrôle. */
export function assertHubQuery(query: string): string {
  const clean = query.trim();
  if (clean.length === 0 || clean.length > 80 || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new HubError("invalid", "Requête de recherche invalide (1 à 80 caractères).");
  }
  return clean;
}

/** Nom de fichier d'un hub : non vide, borné, sans traversée de chemin. */
export function assertHubFileName(name: string): string {
  const clean = name.trim().slice(0, 300);
  if (
    clean.length === 0 ||
    clean.includes("..") ||
    clean.startsWith("/") ||
    clean.includes("\\") ||
    /[\u0000-\u001f]/.test(clean)
  ) {
    throw new HubError("invalid", "Nom de fichier du hub invalide.");
  }
  return clean;
}

/** Fichiers ingérables : CSV, JSON, JSONL, TXT et PARQUET — y compris
 *  compressés .gz (format très fréquent sur les hubs ; décompression
 *  transparente au téléchargement, bornée par le plafond). Le parquet —
 *  format majoritaire des datasets Hugging Face — est parsé en JavaScript
 *  pur (lib/training/hub/parquet.ts, hyparquet : aucune dépendance native). */
export const HUB_DATASET_FILE_RE = /\.(csv|json|jsonl|txt|parquet)(\.gz)?$/i;

/** Encode un chemin de fichier hub en conservant les séparateurs `/`. */
export function encodeHubPath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/* ------------------------------------------------------------------ */
/* Types normalisés                                                    */
/* ------------------------------------------------------------------ */

export const hubDatasetSummarySchema = z.object({
  provider: z.enum(HUB_PROVIDERS),
  ref: z.string().min(1).max(240),
  name: z.string().min(1).max(240),
  description: z.string().max(500).default(""),
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  downloads: z.number().int().nonnegative().nullable().default(null),
  likes: z.number().int().nonnegative().nullable().default(null),
  license: z.string().max(80).nullable().default(null),
  lastModified: z.string().max(40).nullable().default(null),
  tags: z.array(z.string().max(60)).max(12).default([]),
});
export type HubDatasetSummary = z.infer<typeof hubDatasetSummarySchema>;

export const hubFileSchema = z.object({
  name: z.string().min(1).max(300),
  sizeBytes: z.number().int().nonnegative().default(0),
  /** Vrai si l'extension est ingérable par le pipeline (csv/json/jsonl/txt/parquet). */
  downloadable: z.boolean().default(false),
});
export type HubFile = z.infer<typeof hubFileSchema>;

export const hubDatasetDetailSchema = hubDatasetSummarySchema.extend({
  files: z.array(hubFileSchema).max(200).default([]),
  /** Splits DÉCLARÉS par le hub (null = non exposé par l'API). */
  splits: z
    .array(z.object({ name: z.string().max(60), rows: z.number().int().nonnegative().nullable() }))
    .max(20)
    .default([]),
  columns: z.array(z.string().max(80)).max(30).default([]),
  /** Échantillon de lignes RÉELLES (≤ 10, cellules tronquées à 200 caractères). */
  previewRows: z.array(z.record(z.string(), z.unknown())).max(10).default([]),
  /** Limites honnêtes remontées par le connecteur (affichées telles quelles). */
  notes: z.array(z.string().max(300)).max(10).default([]),
  inspectedAt: z.string(),
});
export type HubDatasetDetail = z.infer<typeof hubDatasetDetailSchema>;

/* ------------------------------------------------------------------ */
/* HTTP — timeouts + plafonds                                          */
/* ------------------------------------------------------------------ */

/** Timeout par défaut des appels de métadonnées (recherche / inspection). */
export const HUB_HTTP_TIMEOUT_MS = 12_000;

/** Timeout par défaut du téléchargement d'un fichier de dataset. */
export const HUB_DOWNLOAD_TIMEOUT_MS = 120_000;

/** Plafond des réponses JSON des hubs (5 Mo — largement suffisant). */
const HUB_JSON_CAP_BYTES = 5 * 1024 * 1024;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store", redirect: "follow" });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new HubError("upstream", "Le hub n'a pas répondu dans le délai imparti.");
    }
    throw new HubError("upstream", "Hub injoignable.");
  } finally {
    clearTimeout(timer);
  }
}

/** GET JSON avec timeout + plafond de taille. Non-OK → HubError classé. */
export async function hubFetchJson<T>(url: string, init: RequestInit, timeoutMs = HUB_HTTP_TIMEOUT_MS): Promise<T> {
  const response = await fetchWithTimeout(url, init, timeoutMs);
  if (!response.ok) {
    if (response.status === 404) throw new HubError("not-found", "Jeu de données introuvable sur le hub.");
    if (response.status === 401 || response.status === 403) {
      throw new HubError("config", "Accès refusé par le hub : vérifiez le jeton d'accès configuré côté serveur.");
    }
    throw new HubError("upstream", `Le hub a répondu en erreur (HTTP ${response.status}).`);
  }
  const text = await response.text();
  if (text.length > HUB_JSON_CAP_BYTES) {
    throw new HubError("upstream", "Réponse du hub trop volumineuse.");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HubError("upstream", "Réponse illisible du hub (JSON invalide).");
  }
}

/** Télécharge un fichier binaire avec plafond strict (avant ET après lecture). */
export async function hubDownloadFile(
  url: string,
  init: RequestInit,
  maxBytes: number,
  timeoutMs = HUB_DOWNLOAD_TIMEOUT_MS,
  opts: { partiel?: boolean } = {},
): Promise<{ buffer: Buffer; contentType: string; tronque?: boolean }> {
  const response = await fetchWithTimeout(url, init, timeoutMs);
  if (!response.ok) {
    if (response.status === 404) throw new HubError("not-found", "Fichier introuvable sur le hub.");
    if (response.status === 401 || response.status === 403) {
      throw new HubError("config", "Accès refusé au fichier : vérifiez le jeton d'accès configuré côté serveur.");
    }
    throw new HubError("upstream", `Téléchargement impossible (HTTP ${response.status}).`);
  }
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (!opts.partiel) {
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new HubError("invalid", `Fichier trop volumineux (${Math.round(contentLength / 1048576)} Mo).`);
    }
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new HubError("invalid", `Fichier trop volumineux (${Math.round(arrayBuffer.byteLength / 1048576)} Mo).`);
    }
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: response.headers.get("content-type") || "application/octet-stream",
    };
  }
  // MODE PARTIEL — les grands fichiers sont lus jusqu'au plafond (données
  // décompressées) au lieu d'être refusés : l'auto-apprentissage à grande
  // échelle peut ainsi exploiter des datasets de centaines de Mo en en
  // prenant des premières tranches COMPLÈTES (le parsing ne retient que les
  // lignes intégrales — aucune donnée coupée n'est convertie).
  const lu = await lireCorpsBorne(response, maxBytes);
  return {
    buffer: lu.buffer,
    contentType: response.headers.get("content-type") || "application/octet-stream",
    tronque: lu.tronque,
  };
}

/** Lecture bornée du corps d'une réponse (données décompressées si
 *  content-encoding, plafond strict — jamais plus de maxBytes en RAM). */
async function lireCorpsBorne(
  response: Response,
  maxBytes: number,
): Promise<{ buffer: Buffer; tronque: boolean }> {
  if (!response.body) throw new HubError("upstream", "Corps de réponse absent.");
  const lecteur = response.body.getReader();
  const morceaux: Buffer[] = [];
  let total = 0;
  let tronque = false;
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      const restant = maxBytes - total;
      if (restant > 0) {
        morceaux.push(Buffer.from(value.slice(0, restant)));
        total += restant;
      }
      tronque = true;
      await lecteur.cancel().catch(() => {});
      break;
    }
    morceaux.push(Buffer.from(value));
    total += value.byteLength;
  }
  return { buffer: Buffer.concat(morceaux, total), tronque };
}

/* ------------------------------------------------------------------ */
/* Aperçu CSV — parseur avec guillemets, borné lignes/colonnes           */
/* ------------------------------------------------------------------ */

/** Parse une ligne CSV (guillemets doubles échappés, délimiteur fourni). */
export function parseCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

export interface CsvPreview {
  header: string[];
  rows: string[][];
}

/**
 * Extrait un aperçu CSV borné : détecte le délimiteur (`,` vs `;`),
 * plafonne les lignes et colonnes, tolère les guillemets.
 */
export function parseCsvPreview(text: string, maxRows = 10, maxCols = 20): CsvPreview {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, maxRows + 1);
  if (lines.length === 0) return { header: [], rows: [] };
  const first = lines[0];
  const delimiter = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  const header = parseCsvLine(first, delimiter).map((cell) => cell.trim()).slice(0, maxCols);
  const rows = lines.slice(1).map((line) => parseCsvLine(line, delimiter).slice(0, maxCols));
  return { header, rows };
}

/** Convertit un aperçu CSV en lignes-objets (clé = en-tête de colonne). */
export function csvPreviewToRows(preview: CsvPreview): Array<Record<string, unknown>> {
  return preview.rows.map((row) => {
    const record: Record<string, unknown> = {};
    preview.header.forEach((key, index) => {
      record[key] = row[index] ?? "";
    });
    return record;
  });
}

/** Tronque chaque cellule d'un échantillon (doc stocké < 256 Ko). */
export function truncatePreviewRows(
  rows: Array<Record<string, unknown>>,
  maxRows = 10,
  maxCells = 200,
): Array<Record<string, unknown>> {
  return rows.slice(0, maxRows).map((row) => {
    const truncated: Record<string, unknown> = {};
    let count = 0;
    for (const [key, value] of Object.entries(row).slice(0, 20)) {
      if (count >= maxCells) break;
      if (typeof value === "string") {
        truncated[key.slice(0, 80)] = value.slice(0, 200);
      } else if (value !== null && typeof value === "object") {
        try {
          truncated[key.slice(0, 80)] = JSON.stringify(value)?.slice(0, 200) ?? null;
        } catch {
          truncated[key.slice(0, 80)] = null;
        }
      } else {
        truncated[key.slice(0, 80)] = value;
      }
      count++;
    }
    return truncated;
  });
}

/* ------------------------------------------------------------------ */
/* Sélection des fichiers à importer (plafonds serveur)                  */
/* ------------------------------------------------------------------ */

export interface HubImportCaps {
  perFileBytes: number;
  totalBytes: number;
  maxFiles: number;
}

export interface HubFileSelection {
  selected: HubFile[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Choisit les fichiers réellement importables d'un dataset de hub :
 *  - extensions ingérables uniquement (.csv/.json/.jsonl/.txt/.parquet) ;
 *  - plafond par fichier, plafond total, nombre maximal de fichiers ;
 *  - les fichiers dont la taille est inconnue (API HF) sont tentés : le
 *    plafond reste appliqué AU TÉLÉCHARGEMENT (hubDownloadFile).
 *
 * Les exclusions sont retournées AVEC leur raison (affichage honnête).
 */
export function selectFilesForImport(
  detail: Pick<HubDatasetDetail, "files">,
  caps: HubImportCaps,
  requested?: string[],
): HubFileSelection {
  const wanted = requested?.map((name) => name.trim()).filter(Boolean);
  const candidates = detail.files.filter((file) => {
    if (!file.downloadable) return false;
    if (wanted && wanted.length > 0 && !wanted.includes(file.name)) return false;
    return true;
  });

  const selection: HubFileSelection = { selected: [], skipped: [] };
  for (const file of detail.files) {
    if (!file.downloadable) {
      if (!wanted || wanted.length === 0 || wanted.includes(file.name)) {
        selection.skipped.push({
          name: file.name,
          reason: "Format non ingérable (seuls .csv, .json, .jsonl, .txt et .parquet sont analysés).",
        });
      }
    }
  }

  // Ordre déterministe : fichiers de taille connue d'abord (desc), puis inconnues.
  const ordered = [...candidates].sort((a, b) => {
    const sizeA = a.sizeBytes > 0 ? a.sizeBytes : -1;
    const sizeB = b.sizeBytes > 0 ? b.sizeBytes : -1;
    return sizeB - sizeA;
  });

  let total = 0;
  for (const file of ordered) {
    if (selection.selected.length >= caps.maxFiles) {
      selection.skipped.push({ name: file.name, reason: `Nombre maximal de fichiers par import (${caps.maxFiles}) atteint.` });
      continue;
    }
    if (file.sizeBytes > caps.perFileBytes) {
      selection.skipped.push({
        name: file.name,
        reason: `Fichier trop volumineux (${Math.round(file.sizeBytes / 1048576)} Mo > plafond ${Math.round(caps.perFileBytes / 1048576)} Mo).`,
      });
      continue;
    }
    // Taille inconnue (HF) : comptée à 0 ici, le plafond réel reste au téléchargement.
    const projected = total + file.sizeBytes;
    if (projected > caps.totalBytes) {
      selection.skipped.push({
        name: file.name,
        reason: `Plafond total de l'import atteint (${Math.round(caps.totalBytes / 1048576)} Mo).`,
      });
      continue;
    }
    selection.selected.push(file);
    total = projected;
  }

  if (wanted && wanted.length > 0) {
    const selectedNames = new Set(selection.selected.map((file) => file.name));
    for (const name of wanted) {
      if (!selectedNames.has(name) && !selection.skipped.some((entry) => entry.name === name)) {
        selection.skipped.push({ name, reason: "Fichier absent de ce jeu de données." });
      }
    }
  }

  return selection;
}
