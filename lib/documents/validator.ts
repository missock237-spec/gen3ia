import {
  ArtifactFormatSchema,
} from "./types";

import {
  MIME_TYPES,
} from "./mime";

import * as jsYaml from "js-yaml";

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

  // Moteur documentaire — validation réelle des nouveaux formats :
  // ODF (odt/ods/odp) = conteneur ZIP dont la première entrée est
  // « mimetype » non compressée ; RTF = signature {\rtf ; YAML =
  // rechargement par le parseur (le fichier généré doit être relisible).
  if (format === "odt" || format === "ods" || format === "odp") {
    const signature = data.subarray(0, 2).toString("hex");
    if (signature !== "504b") {
      errors.push("Invalid OpenDocument signature (not a ZIP container).");
    } else {
      // La première entrée locale doit s'appeler « mimetype » (spéc ODF).
      const nomEntree = data.subarray(30, 38).toString("ascii");
      if (nomEntree !== "mimetype") {
        warnings.push("OpenDocument first entry is not « mimetype ».");
      }
    }
  }

  if (format === "rtf") {
    const entete = data.subarray(0, 5).toString("ascii");
    if (entete !== "{\\rtf") {
      errors.push("Invalid RTF signature (missing {\\rtf).");
    }
  }

  if (format === "yaml") {
    // Reliure réelle : un YAML généré doit être rechargé sans exception
    // (js-yaml est une dépendance légère déjà partagée par le dépôt).
    try {
      jsYaml.load(data.toString("utf8"));
    } catch (error) {
      errors.push(
        `Invalid YAML document: ${error instanceof Error ? error.message : String(error)}`,
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
