export const EXTENSIONS = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  csv: "csv",
  md: "md",
  txt: "txt",
  json: "json",
  html: "html",
  zip: "zip",
} as const;

export const MIME_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
} as const;

export type ArtifactFormatKey = keyof typeof EXTENSIONS;

const FORMAT_BY_EXTENSION = new Map<string, ArtifactFormatKey>(
  Object.entries(EXTENSIONS).map(([format, extension]) => [extension, format as ArtifactFormatKey]),
);

/**
 * Resolves the supported artifact format from a filename extension.
 * Returns null for unknown or unsupported extensions.
 */
export function formatFromFilename(
  filename: string,
): ArtifactFormatKey | null {
  const extension =
    filename
      .split(".")
      .pop()
      ?.toLowerCase() ?? "";

  return FORMAT_BY_EXTENSION.get(extension) ?? null;
}

export function getMimeType(format: ArtifactFormatKey): string {
  return MIME_TYPES[format];
}
