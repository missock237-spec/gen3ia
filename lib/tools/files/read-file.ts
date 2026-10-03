import { z } from "zod";

import { ATTACHMENT_MAX_FILE_BYTES } from "@/lib/files/attachment-policy";
import { convertFileBuffer, isOwnedPermanentKey } from "@/lib/files/import";
import { downloadFromR2 } from "@/lib/storage/r2";
import { readWorkspaceFile } from "@/lib/documents/file-engine";
import { assertWorkspaceOwner } from "@/lib/execution/workspace-registry";
import type { ToolDefinition } from "../types";

/**
 * file.read — LECTURE RÉELLE de fichiers pour les agents (exigence production :
 * « les pièces jointes associées doivent pouvoir être utilisées par l'agent
 * IA selon la demande de l'utilisateur »).
 *
 * Avant ce module, l'outil `file.read` était annoncé au planificateur mais
 * AUCUN exécuteur n'était enregistré : toute étape `file.read` échouait
 * (« Unknown tool ») — et la note de contexte du chat d'agent suggérait un
 * outil mort. Deux cibles de lecture réelles, selon la clé fournie :
 *
 *  1. CLÉ DE STOCKAGE PERMANENT (`users/<uid>/permanent/...`) : uniquement
 *     si `<uid>` est l'utilisateur de l'exécution (cloisonnement strict) —
 *     téléchargement R2 puis conversion réelle (texte, CSV, JSON, XLSX,
 *     DOCX, HTML, PDF natif). C'est ainsi qu'un agent lit les pièces
 *     jointes du chat et le fichier mémoire de son agent.
 *  2. FICHIER DE WORKSPACE (`workspaceId` + chemin relatif) : lecture du
 *     workspace d'exécution autorisé (protection anti-traversée conservée).
 *
 * La sortie texte est plafonnée (FILE_READ_OUTPUT_CHARS) : au-delà, un
 * extrait + les métadonnées réelles sont renvoyés et l'agent peut affiner
 * (ex. ré-ingestion Knowledge, découpage côté étape).
 */

/** Plafond de caractères renvoyés à l'agent (budget de contexte outillage). */
const FILE_READ_OUTPUT_CHARS = 48_000;

const inputSchema = z.object({
  /** Chemin R2 permanent (`users/<uid>/permanent/...`) OU chemin relatif workspace. */
  path: z.string().trim().min(1).max(1024),
  /** Workspace d'exécution autorisé (obligatoire pour un chemin non-R2). */
  workspaceId: z.string().trim().min(1).max(128).optional(),
});

function safeRelativePath(filename: string): string {
  const normalized = filename.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").some((part) => part === "..")) {
    throw new Error("Unsafe workspace path");
  }
  const clean = normalized.split("/").filter((part) => part.length > 0).join("/");
  if (!clean || clean === "." || clean.startsWith("../") || clean.includes("/../")) throw new Error("Unsafe workspace path");
  return clean;
}

export const readFileTool: ToolDefinition = {
  id: "file.read",
  name: "file.read",
  description: "Read a REAL file: an attachment from the owner's permanent storage (users/<uid>/permanent/...) or an authorized workspace file (workspaceId + path). Returns converted text content plus real metadata.",
  category: "files",
  risk: "low",
  inputSchema,
  execute: async (input, context) => {
    const parsed = inputSchema.parse(input);

    // 1) Stockage permanent R2 — cloisonné au propriétaire de l'exécution.
    if (isOwnedPermanentKey(context.userId, parsed.path)) {
      const buffer = await downloadFromR2(parsed.path, ATTACHMENT_MAX_FILE_BYTES);
      if (!buffer || buffer.length === 0) throw new Error("Fichier introuvable dans le stockage.");
      const filename = parsed.path.split("/").pop() || "fichier";
      const conversion = await convertFileBuffer(buffer, filename, "application/octet-stream", buffer.length);
      const truncated = conversion.text.length > FILE_READ_OUTPUT_CHARS;
      return {
        success: true,
        source: "permanent" as const,
        path: parsed.path,
        filename,
        sizeBytes: buffer.length,
        kind: conversion.kind,
        conversion: conversion.conversion,
        charCount: conversion.text.length,
        rowCount: conversion.rowCount,
        pageCount: conversion.pageCount,
        content: conversion.text
          ? (truncated ? `${conversion.text.slice(0, FILE_READ_OUTPUT_CHARS)}…` : conversion.text)
          : (conversion.note ?? "(contenu non textuel — métadonnées seulement)"),
        truncated,
      };
    }

    // 2) Workspace d'exécution autorisé.
    if (!parsed.workspaceId) {
      throw new Error("Chemin hors stockage permanent : fournissez workspaceId pour lire un fichier de workspace autorisé.");
    }
    const workspace = await assertWorkspaceOwner(parsed.workspaceId, context.userId);
    const relative = safeRelativePath(parsed.path);
    const data = await readWorkspaceFile({ workspaceRoot: workspace.root, relativePath: relative });
    const text = data.toString("utf8");
    const looksBinary = text.slice(0, 2_000).includes("\u0000");
    const truncated = text.length > FILE_READ_OUTPUT_CHARS;
    return {
      success: true,
      source: "workspace" as const,
      path: relative,
      workspaceId: workspace.id,
      sizeBytes: data.length,
      kind: looksBinary ? ("binary" as const) : ("text" as const),
      conversion: looksBinary ? ("metadata-only" as const) : ("full" as const),
      charCount: text.length,
      content: looksBinary
        ? `(fichier binaire de workspace — ${data.length} octets)`
        : (truncated ? `${text.slice(0, FILE_READ_OUTPUT_CHARS)}…` : text),
      truncated: looksBinary ? false : truncated,
    };
  },
};
