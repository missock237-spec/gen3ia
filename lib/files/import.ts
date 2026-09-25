import "server-only";

import { randomUUID } from "crypto";
import { inflateSync, inflateRawSync } from "zlib";

import { adminDb } from "@/lib/firebase/admin";
import { docxToText, htmlToText } from "@/lib/knowledge/ingestion";

/**
 * Import de fichiers RÉELLEMENT converti et stocké en base de données :
 *  1) conversion réelle du fichier téléversé (texte, CSV → lignes, JSON →
 *     structure, XLSX → feuilles/lignes, DOCX/HTML → texte, PDF texte natif) ;
 *  2) persistance Firestore dans la collection `importedFiles` (la base du
 *     projet) — le contenu converti devient disponible pour le modèle ;
 *  3) contexte injecté dans les tours de conversation (contenu RÉEL, jamais
 *     le simple nom de fichier).
 */

export const IMPORT_MAX_FILE_BYTES = 20_000_000;
/** Taille maximale du texte stocké par document (limite doc Firestore ≈ 1 Mo). */
export const IMPORT_MAX_TEXT_CHARS = 600_000;
/** Nombre maximal de lignes structurées stockées (aperçu complet conservé via texte). */
export const IMPORT_MAX_STRUCTURED_ROWS = 500;

export type ImportedFileKind = "text" | "markdown" | "csv" | "json" | "html" | "docx" | "xlsx" | "pdf" | "image" | "binary";

export interface ImportedFileRecord {
  id: string;
  userId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  kind: ImportedFileKind;
  charCount: number;
  rowCount?: number;
  sheetCount?: number;
  pageCount?: number;
  conversion: "full" | "metadata-only";
  conversationId?: string;
  projectId?: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Conversion réelle — fonctions pures (testables)                     */
/* ------------------------------------------------------------------ */

export interface ConversionResult {
  kind: ImportedFileKind;
  text: string;
  structured?: { headers: string[]; rows: string[][] } | unknown;
  rowCount?: number;
  sheetCount?: number;
  pageCount?: number;
  conversion: "full" | "metadata-only";
  note?: string;
}

/** Détecte le délimiteur CSV (, ou ;) selon les occurrences hors guillemets. */
export function detectCsvDelimiter(sample: string): "," | ";" | "\t" {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const char of sample.slice(0, 5_000)) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char in counts) counts[char as "," | ";" | "\t"] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? (best[0] as "," | ";" | "\t") : ",";
}

/** Parseur CSV réel : guillemets doubles, échappements, multi-lignes. */
export function parseCsv(content: string, delimiter?: string): { headers: string[]; rows: string[][] } {
  const delim = delimiter ?? detectCsvDelimiter(content);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (row.length > 1 || row[0]?.trim() !== "") rows.push(row);
    row = [];
  };

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (inQuotes) {
      if (char === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delim) {
      pushField();
    } else if (char === "\n") {
      pushRow();
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length) pushRow();

  const headers = (rows.shift() ?? []).map((header) => header.trim());
  return { headers, rows };
}

/** Extraction texte d'un PDF natif (streams décompressés + opérateurs de texte). */
export function pdfToText(buffer: Buffer): { text: string; pageCount: number } {
  const raw = buffer.toString("latin1");
  const pageCount = Math.max((raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length, 0);
  const chunks: string[] = [];
  const streamRe = /stream\r?\n?([\s\S]*?)endstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(raw)) !== null) {
    const streamBody = Buffer.from(match[1], "latin1");
    let content: string | null = null;
    try {
      content = inflateSync(streamBody).toString("latin1");
    } catch {
      try {
        content = inflateRawSync(streamBody).toString("latin1");
      } catch {
        content = match[1]; // stream non compressé : opérateurs lisibles directs
      }
    }
    if (!content || !/(Tj|TJ)/.test(content)) continue;
    const textParts: string[] = [];
    const tokenRe = /\((?:\\.|[^\\)])*\)|TJ|Tj|T\*|Td|TD|ET|BT|<([0-9A-Fa-f\s]+)>/g;
    let token: RegExpExecArray | null;
    while ((token = tokenRe.exec(content)) !== null) {
      if (token[0] === "T*" || token[0] === "Td" || token[0] === "TD" || token[0] === "ET") {
        textParts.push("\n");
      } else if (token[1] !== undefined) {
        // Chaîne hexadécimale (UTF-16BE fréquent dans les PDF générés)
        const hex = token[1].replace(/\s+/g, "");
        let decoded = "";
        for (let i = 0; i + 3 < hex.length + 1; i += 4) {
          const code = Number.parseInt(hex.slice(i, i + 4), 16);
          if (!Number.isNaN(code) && code >= 32) decoded += String.fromCharCode(code);
        }
        if (decoded) textParts.push(decoded);
      } else {
        const literal = token[0].slice(1, -1)
          .replace(/\\([nrtbf()\\])/g, (_, escaped: string) =>
            ({ n: "\n", r: "\n", t: "\t", b: "", f: "" })[escaped] ?? escaped)
          .replace(/\\[0-7]{1,3}/g, (oct) => String.fromCharCode(Number.parseInt(oct.slice(1), 8)));
        if (literal) textParts.push(literal);
      }
    }
    const extracted = textParts.join("").trim();
    if (extracted.length > 20) chunks.push(extracted);
  }

  const text = chunks
    .join("\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, pageCount };
}

/** Conversion RÉELLE d'un fichier téléversé selon son type. */
export async function convertUploadedFile(file: File): Promise<ConversionResult> {
  if (file.size > IMPORT_MAX_FILE_BYTES) {
    throw new Error(`Fichier trop volumineux (max ${Math.round(IMPORT_MAX_FILE_BYTES / 1_000_000)} Mo).`);
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  const extension = name.includes(".") ? name.split(".").pop()! : "";

  // Images : métadonnées réelles, pas de « conversion » texte illusoire.
  if (file.type.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension)) {
    return { kind: "image", text: "", conversion: "metadata-only", note: "Image importée : métadonnées stockées (pas de contenu texte)." };
  }

  if (extension === "docx" || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const text = await docxToText(buffer);
    return { kind: "docx", text, conversion: text ? "full" : "metadata-only" };
  }

  if (["xlsx", "xlsm"].includes(extension) || file.type.includes("spreadsheetml")) {
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const allRows: string[][] = [];
    let sheetCount = 0;
    workbook.eachSheet((sheet) => {
      sheetCount += 1;
      sheet.eachRow((row) => {
        const values = (row.values as unknown[]).slice(1).map((value) =>
          value === null || value === undefined ? "" : String(value instanceof Date ? value.toISOString().slice(0, 10) : value),
        );
        if (values.some((value) => value !== "")) allRows.push(values);
      });
    });
    const headers = allRows.shift() ?? [];
    const rows = allRows.slice(0, IMPORT_MAX_STRUCTURED_ROWS);
    const text = [headers.join(","), ...allRows.slice(0, IMPORT_MAX_STRUCTURED_ROWS).map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(","))].join("\n");
    return { kind: "xlsx", text, structured: { headers, rows }, rowCount: allRows.length, sheetCount, conversion: "full" };
  }

  if (extension === "pdf" || file.type === "application/pdf") {
    const { text, pageCount } = pdfToText(buffer);
    if (text.replace(/[^A-Za-zÀ-ÿ0-9]/g, "").length < 30) {
      return {
        kind: "pdf",
        text: "",
        pageCount,
        conversion: "metadata-only",
        note: "PDF importé mais aucun texte natif extractible (probablement un PDF scanné). Le fichier est stocké ; convertissez-le en DOCX/TXT pour l'analyse de contenu.",
      };
    }
    return { kind: "pdf", text, pageCount, conversion: "full" };
  }

  if (extension === "json" || file.type === "application/json") {
    const text = buffer.toString("utf8");
    let structured: unknown;
    try {
      structured = JSON.parse(text);
    } catch {
      return { kind: "json", text, conversion: "full", note: "JSON invalide : conservé en texte brut." };
    }
    return { kind: "json", text, structured, conversion: "full" };
  }

  if (extension === "csv" || extension === "tsv" || file.type === "text/csv") {
    const text = buffer.toString("utf8");
    const { headers, rows } = parseCsv(text, extension === "tsv" ? "\t" : undefined);
    return {
      kind: "csv",
      text,
      structured: { headers, rows: rows.slice(0, IMPORT_MAX_STRUCTURED_ROWS) },
      rowCount: rows.length,
      conversion: "full",
    };
  }

  if (extension === "html" || extension === "htm" || file.type === "text/html") {
    const text = htmlToText(buffer.toString("utf8"));
    return { kind: "html", text, conversion: "full" };
  }

  if (extension === "md" || extension === "markdown" || file.type === "text/markdown") {
    return { kind: "markdown", text: buffer.toString("utf8"), conversion: "full" };
  }

  const text = buffer.toString("utf8");
  const looksBinary = text.slice(0, 2_000).includes("\u0000");
  if (looksBinary) {
    return { kind: "binary", text: "", conversion: "metadata-only", note: "Fichier binaire : métadonnées stockées sans conversion." };
  }
  return { kind: "text", text, conversion: "full" };
}

/* ------------------------------------------------------------------ */
/* Persistance Firestore — collection `importedFiles`                  */
/* ------------------------------------------------------------------ */

const COLLECTION = "importedFiles";

export interface StoredImportedFile extends ImportedFileRecord {
  /** Texte converti stocké en base (tronqué à IMPORT_MAX_TEXT_CHARS). */
  textContent: string;
  structuredPreview?: { headers: string[]; rows: string[][] };
  note?: string;
}

export async function persistImportedFile(input: {
  userId: string;
  file: File;
  conversion: ConversionResult;
  conversationId?: string;
  projectId?: string;
}): Promise<StoredImportedFile> {
  const { conversion } = input;
  const id = randomUUID();
  const now = new Date().toISOString();
  const record: StoredImportedFile = {
    id,
    userId: input.userId,
    filename: input.file.name.slice(0, 300),
    contentType: (input.file.type || "application/octet-stream").slice(0, 160),
    sizeBytes: input.file.size,
    kind: conversion.kind,
    conversion: conversion.conversion,
    charCount: conversion.text.length,
    ...(conversion.rowCount !== undefined ? { rowCount: conversion.rowCount } : {}),
    ...(conversion.sheetCount !== undefined ? { sheetCount: conversion.sheetCount } : {}),
    ...(conversion.pageCount !== undefined ? { pageCount: conversion.pageCount } : {}),
    ...(conversion.note ? { note: conversion.note.slice(0, 500) } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId.slice(0, 128) } : {}),
    ...(input.projectId ? { projectId: input.projectId.slice(0, 128) } : {}),
    createdAt: now,
    textContent: conversion.text.slice(0, IMPORT_MAX_TEXT_CHARS),
    ...(conversion.structured && typeof conversion.structured === "object" && "headers" in conversion.structured
      ? { structuredPreview: conversion.structured as { headers: string[]; rows: string[][] } }
      : {}),
  };
  await adminDb.collection(COLLECTION).doc(id).set(record);
  return record;
}

/** Vue sans contenu : listing (le texte complet reste côté serveur). */
export function importedFileView(record: StoredImportedFile): ImportedFileRecord {
  const { textContent: _text, structuredPreview: _structured, ...view } = record;
  return view;
}

export async function listImportedFiles(userId: string, limit = 50): Promise<ImportedFileRecord[]> {
  let docs: Array<{ id: string; data: () => Record<string, unknown> }>;
  try {
    const snapshot = await adminDb.collection(COLLECTION).where("userId", "==", userId).orderBy("createdAt", "desc").limit(limit).get();
    docs = snapshot.docs;
  } catch {
    const snapshot = await adminDb.collection(COLLECTION).where("userId", "==", userId).limit(limit).get();
    docs = snapshot.docs;
  }
  return docs
    .map((doc) => importedFileView(doc.data() as unknown as StoredImportedFile & { id: string }))
    .filter((record) => record.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getImportedFileContent(userId: string, id: string): Promise<StoredImportedFile | null> {
  const doc = await adminDb.collection(COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  const record = doc.data() as StoredImportedFile;
  if (record.userId !== userId) return null;
  return { ...record, id: doc.id };
}

/* ------------------------------------------------------------------ */
/* Contexte modèle — contenu RÉEL injecté dans le tour                 */
/* ------------------------------------------------------------------ */

const MAX_CHARS_PER_FILE = 12_000;
const MAX_TOTAL_CHARS = 36_000;

/** Charge le contenu converti des fichiers joints (référencés par fileId). */
export async function loadImportedFilesContext(
  userId: string,
  attachments?: Array<{ fileId?: string; filename?: string }>,
  budget: { perFile?: number; total?: number } = {},
): Promise<string> {
  const perFile = budget.perFile ?? 12_000;
  const maxTotal = budget.total ?? 36_000;
  if (!attachments || attachments.length === 0) return "";
  const fileIds = attachments.map((a) => a.fileId).filter((id): id is string => Boolean(id)).slice(0, 8);
  if (fileIds.length === 0) return "";

  const parts: string[] = [];
  let total = 0;
  for (const fileId of fileIds) {
    const record = await getImportedFileContent(userId, fileId).catch(() => null);
    if (!record) continue;
    const label =
      record.conversion === "full"
        ? `${record.charCount.toLocaleString("fr-FR")} caractères convertis`
        : "métadonnées seulement";
    const header = `Fichier importé « ${record.filename} » (${record.kind}, ${label}${record.rowCount !== undefined ? `, ${record.rowCount} lignes` : ""}) :`;
    const body = record.textContent ? record.textContent.slice(0, Math.min(perFile, maxTotal - total)) : record.note ?? "(aucun contenu texte)";
    parts.push(`${header}\n${body}`);
    total += header.length + body.length;
    if (total >= maxTotal) break;
  }
  return parts.length > 0 ? `\n\nContenu RÉEL des fichiers importés (stockés en base de données) :\n${parts.join("\n\n---\n\n")}` : "";
}
