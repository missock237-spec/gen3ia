import "server-only";

import { randomUUID } from "crypto";

import { adminDb } from "@/lib/firebase/admin";
import { ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_FILES } from "@/lib/files/attachment-policy";
import { pdfToText } from "@/lib/files/pdf-text";
import { docxToText, htmlToText } from "@/lib/knowledge/ingestion";
import { mapWithConcurrency } from "@/lib/video/concurrency";
import { downloadFromR2, isR2Configured, uploadToR2 } from "@/lib/storage/r2";

/**
 * Import de fichiers RÉELLEMENT converti et stocké en base de données :
 *  1) conversion réelle du fichier téléversé (texte, CSV → lignes, JSON →
 *     structure, XLSX → feuilles/lignes, DOCX/HTML → texte, PDF texte natif) ;
 *  2) persistance Firestore dans la collection `importedFiles` (la base du
 *     projet) — le contenu converti devient disponible pour le modèle ;
 *  3) contexte injecté dans les tours de conversation (contenu RÉEL, jamais
 *     le simple nom de fichier).
 *
 * DEUX canaux d'entrée (politique unifiée 10 fichiers × 50 Mo) :
 *  - canal direct : FormData → /api/files/import (fichiers ≤ limite corps
 *    serverless) ;
 *  - canal R2 : { path } JSON d'un fichier DÉJÀ téléversé dans le stockage
 *    permanent (multipart présigné) — le serveur télécharge depuis R2 puis
 *    convertit : les 50 Mo passent RÉELLEMENT en production.
 */

export const IMPORT_MAX_FILE_BYTES = ATTACHMENT_MAX_FILE_BYTES;

/** Préfixe de clé R2 autorisé pour le canal R2 (cloisonnement par propriétaire). */
export function permanentKeyPrefix(userId: string): string {
  return `users/${userId}/permanent/`;
}

/** Vérifie qu'une clé R2 appartient bien au stockage PERMANENT de l'utilisateur. */
export function isOwnedPermanentKey(userId: string, path: string): boolean {
  return typeof path === "string" && path.startsWith(permanentKeyPrefix(userId)) && path.length <= 500;
}
/** Taille maximale du texte stocké par document (limite doc Firestore ≈ 1 Mo). */
export const IMPORT_MAX_TEXT_CHARS = 600_000;
/** Nombre maximal de lignes structurées stockées (aperçu complet conservé via texte). */
export const IMPORT_MAX_STRUCTURED_ROWS = 500;

export type ImportedFileKind = "text" | "markdown" | "csv" | "json" | "html" | "docx" | "xlsx" | "pdf" | "image" | "audio" | "video" | "binary";

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
  /** Clé R2 du binaire persisté (images : rend l'image éditable/affichable). */
  path?: string;
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

/** Extraction texte d'un PDF natif — ré-export du module pur partagé. */
export { pdfToText } from "@/lib/files/pdf-text";

/** Conversion RÉELLE d'un fichier téléversé selon son type. */
export async function convertUploadedFile(file: File): Promise<ConversionResult> {
  if (file.size > IMPORT_MAX_FILE_BYTES) {
    throw new Error(`Fichier trop volumineux (max ${Math.round(IMPORT_MAX_FILE_BYTES / (1024 * 1024))} Mo).`);
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  return convertFileBuffer(buffer, file.name, file.type, file.size);
}

/**
 * Conversion RÉELLE d'un contenu binaire (cœur réutilisable) — utilisée par
 * le canal direct (File) ET le canal R2 (buffer téléchargé du stockage
 * permanent). Pure vis-à-vis du transport : mêmes résultats sur les deux
 * canaux.
 */
export async function convertFileBuffer(
  buffer: Buffer,
  filename: string,
  contentType: string,
  sizeBytes: number,
): Promise<ConversionResult> {
  if (sizeBytes > IMPORT_MAX_FILE_BYTES) {
    throw new Error(`Fichier trop volumineux (max ${Math.round(IMPORT_MAX_FILE_BYTES / (1024 * 1024))} Mo).`);
  }
  const name = filename.toLowerCase();
  const extension = name.includes(".") ? name.split(".").pop()! : "";

  // Images : métadonnées réelles, pas de « conversion » texte illusoire.
  if (contentType.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension)) {
    return { kind: "image", text: "", conversion: "metadata-only", note: "Image importée : métadonnées stockées (pas de contenu texte)." };
  }

  // Audios : kind dédié (audit multimodal) — l'ancien chemin tombait en
  // « binary » sans note utile. L'analyse réelle (durée, codecs, dynamique)
  // est disponible via media.analyze / l'analyse automatique du chat ; la
  // transcription vocale parlée n'est pas incluse dans le moteur local.
  if (contentType.startsWith("audio/") || ["mp3", "wav", "m4a", "aac", "ogg", "oga", "opus", "flac"].includes(extension)) {
    return {
      kind: "audio",
      text: "",
      conversion: "metadata-only",
      note: "Audio importé : métadonnées stockées. L'analyse locale (durée, codecs, profil sonore) est disponible — demandez « analyse cet audio ». La transcription vocale parlée n'est pas incluse dans le moteur local.",
    };
  }

  // Vidéos : kind dédié (audit multimodal) — l'analyse locale (durée,
  // dimensions, images clés) est disponible via media.analyze.
  if (contentType.startsWith("video/") || ["mp4", "webm", "mov", "m4v", "mkv"].includes(extension)) {
    return {
      kind: "video",
      text: "",
      conversion: "metadata-only",
      note: "Vidéo importée : métadonnées stockées. L'analyse locale (durée, dimensions, images clés) est disponible — demandez « analyse cette vidéo ».",
    };
  }

  if (extension === "docx" || contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const text = await docxToText(buffer);
    return { kind: "docx", text, conversion: text ? "full" : "metadata-only" };
  }

  if (["xlsx", "xlsm"].includes(extension) || contentType.includes("spreadsheetml")) {
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

  if (extension === "pdf" || contentType === "application/pdf") {
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

  if (extension === "json" || contentType === "application/json") {
    const text = buffer.toString("utf8");
    let structured: unknown;
    try {
      structured = JSON.parse(text);
    } catch {
      return { kind: "json", text, conversion: "full", note: "JSON invalide : conservé en texte brut." };
    }
    return { kind: "json", text, structured, conversion: "full" };
  }

  if (extension === "csv" || extension === "tsv" || contentType === "text/csv") {
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

  if (extension === "html" || extension === "htm" || contentType === "text/html") {
    const text = htmlToText(buffer.toString("utf8"));
    return { kind: "html", text, conversion: "full" };
  }

  if (extension === "md" || extension === "markdown" || contentType === "text/markdown") {
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

/**
 * Convertit un fichier DÉJÀ téléversé dans le stockage permanent de
 * l'utilisateur (canal R2 — multipart présigné) : téléchargement R2 puis
 * conversion réelle. Le cloisonnement est vérifié AVANT tout téléchargement
 * (seul le préfixe permanent de CE propriétaire est lisible).
 */
export async function convertPermanentFile(input: {
  userId: string;
  path: string;
  filename: string;
  contentType?: string;
  sizeBytes?: number;
}): Promise<{ conversion: ConversionResult; buffer: Buffer; contentType: string }> {
  if (!isOwnedPermanentKey(input.userId, input.path)) {
    throw new Error("Chemin de stockage invalide pour ce compte.");
  }
  const buffer = await downloadFromR2(input.path, IMPORT_MAX_FILE_BYTES);
  if (!buffer || buffer.length === 0) throw new Error("Fichier introuvable dans le stockage.");
  const contentType = (input.contentType || "application/octet-stream").split(";")[0].trim();
  const conversion = await convertFileBuffer(buffer, input.filename, contentType, buffer.length);
  return { conversion, buffer, contentType };
}

export async function persistImportedFile(input: {
  userId: string;
  /** Canal direct (FormData). Mutuellement exclusif avec permanentDescriptor. */
  file?: File;
  /** Canal R2 : descripteur du fichier déjà présent dans le stockage permanent. */
  permanentDescriptor?: { path: string; filename: string; contentType: string; sizeBytes: number };
  conversion: ConversionResult;
  conversationId?: string;
  projectId?: string;
}): Promise<StoredImportedFile> {
  const { conversion } = input;
  const id = randomUUID();
  const now = new Date().toISOString();
  const descriptor = input.permanentDescriptor
    ? { name: input.permanentDescriptor.filename, type: input.permanentDescriptor.contentType, size: input.permanentDescriptor.sizeBytes }
    : { name: input.file!.name, type: input.file!.type, size: input.file!.size };
  // Étape 8 — le binaire des images importées est réellement persisté dans
  // le stockage permanent de l'utilisateur : l'image devient une source
  // exploitable par l'édition image-to-image (résolue côté serveur) au lieu
  // d'être jetée (« metadata-only » sans ressource).
  // Canal R2 : l'image est DÉJÀ dans le stockage permanent — sa clé existante
  // est réutilisée telle quelle (aucune double copie).
  let imagePath: string | undefined;
  if (conversion.kind === "image" && isR2Configured()) {
    if (input.permanentDescriptor && isOwnedPermanentKey(input.userId, input.permanentDescriptor.path)) {
      imagePath = input.permanentDescriptor.path;
    } else if (input.file) {
      try {
        const buffer = Buffer.from(await input.file.arrayBuffer());
        if (buffer.length > 0 && buffer.length <= IMPORT_MAX_FILE_BYTES) {
          const contentType = (input.file.type || "image/png").split(";")[0].trim();
          const ext = contentType.includes("jpeg") ? "jpg" : contentType.includes("webp") ? "webp" : contentType.includes("gif") ? "gif" : contentType.includes("svg") ? "svg" : "png";
          const key = `users/${input.userId}/permanent/imported-images/${Date.now()}-${id}.${ext}`;
          await uploadToR2(key, buffer, contentType);
          imagePath = key;
        }
      } catch (error) {
        console.warn("[import] persistance R2 de l'image impossible (l'import continue sans la ressource):", error instanceof Error ? error.message : error);
      }
    }
  }
  const record: StoredImportedFile = {
    id,
    userId: input.userId,
    filename: descriptor.name.slice(0, 300),
    contentType: (descriptor.type || "application/octet-stream").slice(0, 160),
    sizeBytes: descriptor.size,
    kind: conversion.kind,
    conversion: conversion.conversion,
    charCount: conversion.text.length,
    ...(conversion.rowCount !== undefined ? { rowCount: conversion.rowCount } : {}),
    ...(conversion.sheetCount !== undefined ? { sheetCount: conversion.sheetCount } : {}),
    ...(conversion.pageCount !== undefined ? { pageCount: conversion.pageCount } : {}),
    ...(imagePath ? { path: imagePath } : {}),
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

/**
 * Charge le contenu converti des fichiers joints et l'assemble en bloc de
 * contexte (mêmes budgets que la politique 10 fichiers × 50 Mo : 12 000
 * caractères par fichier, 60 000 au total, ATTACHMENT_MAX_FILES fichiers).
 *
 * DEUX sources de vérité :
 *  - fileId présent → le contenu converti est relu de la base de données
 *    (collection `importedFiles`, remplie par POST /api/files/import) ;
 *  - FILET DE COMPATIBILITÉ — fileId ABSENT mais `path` présent : le flux
 *    n'est pas passé par /api/files/import (UI historiques aurora/nova/v4
 *    avant branchement, replis non-stream) — le fichier est relu À LA VOLÉE
 *    depuis le stockage PERMANENT du propriétaire (clé R2 cloisonnée par
 *    isOwnedPermanentKey) puis converti avec les MÊMES règles. Les pièces
 *    non textuelles restent honnêtement « métadonnées seulement » (note
 *    explicite dans le bloc) : le moteur est textuel, aucune perception
 *    d'image/audio/vidéo/PDF scanné n'est jamais simulée. Ce filet est là
 *    pour qu'un attachment { path } seul produise quand même un contexte
 *    réel — à supprimer quand toutes les UI émettent systématiquement un
 *    fileId.
 */
export async function loadImportedFilesContext(
  userId: string,
  attachments?: Array<{ fileId?: string; filename?: string; path?: string; contentType?: string }>,
  budget: { perFile?: number; total?: number } = {},
): Promise<string> {
  const perFile = budget.perFile ?? 12_000;
  const maxTotal = budget.total ?? 60_000;
  if (!attachments || attachments.length === 0) return "";

  type ReferenceFichier =
    | { fileId: string }
    | { path: string; filename: string; contentType?: string };
  const references: ReferenceFichier[] = attachments
    .slice(0, ATTACHMENT_MAX_FILES)
    .map((attachment): ReferenceFichier | null => {
      if (attachment.fileId) return { fileId: attachment.fileId };
      if (attachment.path) {
        return {
          path: attachment.path,
          filename: attachment.filename || attachment.path.split("/").pop() || attachment.path,
          ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
        };
      }
      return null;
    })
    .filter((reference): reference is ReferenceFichier => reference !== null);
  if (references.length === 0) return "";

  interface ContenuCharge {
    filename: string;
    kind: ImportedFileKind;
    conversion: "full" | "metadata-only";
    charCount: number;
    rowCount?: number;
    textContent: string;
    note?: string;
    /** "base" = Firestore via fileId ; "storage" = lecture R2 à la volée (filet). */
    source: "base" | "storage";
  }

  const charge = async (reference: ReferenceFichier): Promise<ContenuCharge | null> => {
    if ("fileId" in reference) {
      const record = await getImportedFileContent(userId, reference.fileId).catch(() => null);
      if (!record) return null;
      return {
        filename: record.filename,
        kind: record.kind,
        conversion: record.conversion,
        charCount: record.charCount,
        ...(record.rowCount !== undefined ? { rowCount: record.rowCount } : {}),
        textContent: record.textContent,
        ...(record.note ? { note: record.note } : {}),
        source: "base",
      };
    }
    const echec = (note: string): ContenuCharge => ({
      filename: reference.filename,
      kind: "binary",
      conversion: "metadata-only",
      charCount: 0,
      textContent: "",
      note,
      source: "storage",
    });
    // Cloisonnement : seule la clé permanente de CE propriétaire est lisible.
    if (!isOwnedPermanentKey(userId, reference.path)) {
      return echec("contenu non chargé (chemin hors du stockage permanent du compte)");
    }
    try {
      const buffer = await downloadFromR2(reference.path, ATTACHMENT_MAX_FILE_BYTES);
      if (!buffer || buffer.length === 0) {
        return echec("contenu non chargé (fichier introuvable dans le stockage permanent)");
      }
      const conversion = await convertFileBuffer(
        buffer,
        reference.filename,
        reference.contentType || "application/octet-stream",
        buffer.length,
      );
      return {
        filename: reference.filename,
        kind: conversion.kind,
        conversion: conversion.conversion,
        charCount: conversion.text.length,
        ...(conversion.rowCount !== undefined ? { rowCount: conversion.rowCount } : {}),
        textContent: conversion.text,
        ...(conversion.note ? { note: conversion.note } : {}),
        source: "storage",
      };
    } catch (error) {
      const raison = error instanceof Error ? error.message.slice(0, 160) : "lecture impossible";
      return echec(`contenu non chargé (${raison})`);
    }
  };

  // Lecture PARALLÉLISÉE à concurrence bornée (4), ordre d'entrée préservé —
  // même discipline que loadAgentAttachmentsContext.
  const outcomes = await mapWithConcurrency(references, 4, charge);

  const parts: string[] = [];
  let total = 0;
  let viaStorage = false;
  for (const outcome of outcomes) {
    if (outcome.status !== "fulfilled" || !outcome.value) continue;
    const record = outcome.value;
    if (record.source === "storage") viaStorage = true;
    const label =
      record.conversion === "full"
        ? `${record.charCount.toLocaleString("fr-FR")} caractères convertis${record.source === "storage" ? " (lecture directe du stockage permanent)" : ""}`
        : "métadonnées seulement";
    const header = `Fichier importé « ${record.filename} » (${record.kind}, ${label}${record.rowCount !== undefined ? `, ${record.rowCount} lignes` : ""}) :`;
    const body = record.textContent ? record.textContent.slice(0, Math.min(perFile, maxTotal - total)) : record.note ?? "(aucun contenu texte)";
    parts.push(`${header}\n${body}`);
    total += header.length + body.length;
    if (total >= maxTotal) break;
  }
  // Titre honnête : quand le filet de compatibilité est emprunté, une partie
  // du contenu ne vient PAS de la base — on le dit au lieu de prétendre.
  const titre = viaStorage
    ? "\n\nContenu RÉEL des fichiers importés (base de données ou lecture directe du stockage permanent) :\n"
    : "\n\nContenu RÉEL des fichiers importés (stockés en base de données) :\n";
  return parts.length > 0 ? `${titre}${parts.join("\n\n---\n\n")}` : "";
}
