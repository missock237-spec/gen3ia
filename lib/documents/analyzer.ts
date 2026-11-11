import {
  randomUUID,
} from "node:crypto";

import {
  formatFromFilename,
  MIME_TYPES,
} from "./mime";

import {
  analyzeZip,
} from "./zip";

// Moteur documentaire — cœur d'extraction unifié : l'analyse d'un artifact
// renvoie désormais le TEXTE RÉEL (pdf, docx, odt/ods/odp, pptx, rtf, epub,
// xlsx, csv, json/yaml/xml, code) et les métadonnées mesurées (pages,
// feuilles, dimensions d'image, entrées d'archive) au lieu d'un simple
// « analyzable: true ».
import {
  extraireContenuDocument,
} from "./extraction";

import type {
  ArtifactAnalysis,
  ArtifactFormat,
} from "./types";

export async function analyzeArtifact(
  input: {
    filename: string;
    data: Buffer;
  },
): Promise<ArtifactAnalysis> {
  const artifactId =
    randomUUID();

  const format =
    formatFromFilename(
      input.filename,
    );

  if (!format) {
    return {
      artifactId,
      filename: input.filename,
      format: "txt",
      mimeType:
        "application/octet-stream",
      sizeBytes: input.data.length,
      safe: false,
      warnings: [],
      errors: [
        "Unknown file format.",
      ],
    };
  }

  if (format !== "zip") {
    // Extraction RÉELLE — jamais d'échec silencieux : en cas d'erreur de
    // lecture, l'analyse reste safe:true (le fichier est stocké) et l'erreur
    // est nommée honnêtement.
    try {
      const contenu = await extraireContenuDocument(input.data, input.filename);
      return {
        artifactId,
        filename: input.filename,
        format,
        mimeType: getMimeType(format),
        sizeBytes: input.data.length,
        safe: true,
        warnings: [],
        errors: [],
        extractedText: contenu.texte || undefined,
        metadata: {
          analyzable: true,
          kind: contenu.kind,
          note: contenu.note,
          pages: contenu.pages,
          feuilles: contenu.feuilles,
          dimensions: contenu.dimensions,
          entreesArchive: contenu.entrees?.length,
          caracteresExtraits: contenu.texte.length,
        },
      };
    } catch (error) {
      return {
        artifactId,
        filename: input.filename,
        format,
        mimeType: getMimeType(format),
        sizeBytes: input.data.length,
        safe: true,
        warnings: [],
        errors: [
          `Analyse impossible : ${error instanceof Error ? error.message : String(error)}`,
        ],
        metadata: {
          analyzable: false,
        },
      };
    }
  }

  const result =
    await analyzeZip(
      input.data,
    );

  const extractedText =
    result.textFiles
      .map(
        (file) =>
          `===== ${file.path} =====\n${file.content}`,
      )
      .join("\n\n");

  return {
    artifactId,

    filename: input.filename,

    format: "zip",

    mimeType: "application/zip",

    sizeBytes: input.data.length,

    safe: result.safe,

    files: result.files,

    extractedText,

    warnings: result.warnings,

    errors: result.errors,

    metadata: {
      fileCount: result.fileCount,

      totalUncompressedBytes:
        result.totalUncompressedBytes,

      textFileCount:
        result.textFiles.length,
    },
  };
}

function getMimeType(
  format: ArtifactFormat,
): string {
  return (
    MIME_TYPES[format] ??
    "application/octet-stream"
  );
}
