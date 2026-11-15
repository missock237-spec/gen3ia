import {
  randomUUID,
} from "node:crypto";

import {
  formatFromFilename,
} from "./mime";

import {
  analyzeZip,
} from "./zip";

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
    return {
      artifactId,
      filename: input.filename,
      format,
      mimeType:
        getMimeType(format),
      sizeBytes: input.data.length,
      safe: true,
      warnings: [],
      errors: [],
      metadata: {
        analyzable: true,
      },
    };
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
  const mimeTypes: Record<
    string,
    string
  > = {
    pdf: "application/pdf",
    docx:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    csv: "text/csv",
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    html: "text/html",
  };

  return (
    mimeTypes[String(format)] ??
    "application/octet-stream"
  );
}
