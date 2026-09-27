import {
  ArtifactFormatSchema,
} from "./types";

import {
  MIME_TYPES,
} from "./mime";

export function validateArtifact(
  format: string,
  data: Buffer,
) {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (
    !ArtifactFormatSchema.safeParse(format)
      .success
  ) {
    errors.push(
      `Unsupported artifact format: ${format}`,
    );
  }

  if (!data.length) {
    errors.push(
      "Artifact contains no data.",
    );
  }

  if (format === "json") {
    try {
      JSON.parse(data.toString("utf8"));
    } catch {
      errors.push("Invalid JSON artifact.");
    }
  }

  if (format === "zip") {
    const signature =
      data.subarray(0, 2).toString("hex");

    if (signature !== "504b") {
      errors.push(
        "Invalid ZIP signature.",
      );
    }
  }

  if (format === "pdf") {
    if (
      data
        .subarray(0, 5)
        .toString("ascii") !== "%PDF-"
    ) {
      errors.push(
        "Invalid PDF signature.",
      );
    }
  }

  if (format === "html") {
    const html = data
      .toString("utf8")
      .toLowerCase();

    if (!html.includes("<html")) {
      warnings.push(
        "HTML document has no <html> element.",
      );
    }
  }

  return {
    valid: errors.length === 0,

    format,

    sizeBytes: data.length,

    mimeType:
      MIME_TYPES[
        format as keyof typeof MIME_TYPES
      ] ??
      "application/octet-stream",

    errors,

    warnings,
  };
}
