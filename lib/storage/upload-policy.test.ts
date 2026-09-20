import { describe, expect, it } from "vitest";

import {
  CHUNK_SIZE_BYTES,
  chunkCountFor,
  formatBytes,
  isExtensionAllowed,
  MAX_FILES_PER_BATCH,
  sanitizeFilename,
  validateUploadBatch,
} from "./upload-policy";

describe("upload policy", () => {
  it("accepte un lot de fichiers valides", () => {
    const result = validateUploadBatch([
      { filename: "rapport.pdf", contentType: "application/pdf", sizeBytes: 5 * 1024 * 1024 },
      { filename: "notes.md", contentType: "text/markdown", sizeBytes: 2048 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intents).toHaveLength(2);
      expect(result.totalBytes).toBe(5 * 1024 * 1024 + 2048);
      expect(result.intents[0]?.extension).toBe("pdf");
    }
  });

  it("rejette un lot de plus de 10 fichiers", () => {
    const files = Array.from({ length: MAX_FILES_PER_BATCH + 1 }, (_, i) => ({
      filename: `f${i}.txt`,
      contentType: "text/plain",
      sizeBytes: 10,
    }));
    const result = validateUploadBatch(files);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections[0]?.reason).toContain("Maximum 10");
  });

  it("rejette un fichier de plus de 100 Mo", () => {
    const result = validateUploadBatch([
      { filename: "gros.zip", contentType: "application/zip", sizeBytes: 101 * 1024 * 1024 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections[0]?.reason).toContain("trop volumineux");
  });

  it("rejette les executables et accepte les types documentaires", () => {
    expect(isExtensionAllowed("malware.exe")).toBe(false);
    expect(isExtensionAllowed("script.bat")).toBe(false);
    expect(isExtensionAllowed("archive.jar")).toBe(false);
    expect(isExtensionAllowed("doc.pdf")).toBe(true);
    expect(isExtensionAllowed("image.heic")).toBe(true);
    expect(isExtensionAllowed("data.csv")).toBe(true);
    expect(isExtensionAllowed("sans-extension")).toBe(false);
  });

  it("assainit les noms de fichiers dangereux", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(sanitizeFilename("a\0b/c\\d.png")).toBe("a_b_c_d.png");
    expect(sanitizeFilename("")).toBe("");
    expect(sanitizeFilename(".")).toBe("");
    expect(sanitizeFilename("Rapport — 2026 (final).docx")).toContain("Rapport");
  });

  it("refuse le depassement de quota utilisateur", () => {
    const result = validateUploadBatch(
      [{ filename: "a.pdf", contentType: "application/pdf", sizeBytes: 10 * 1024 * 1024 }],
      { alreadyUsedBytes: 2 * 1024 * 1024 * 1024 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections[0]?.reason).toContain("Quota");
  });

  it("calcule le nombre de chunks", () => {
    expect(chunkCountFor(0)).toBe(0);
    expect(chunkCountFor(1)).toBe(1);
    expect(chunkCountFor(CHUNK_SIZE_BYTES)).toBe(1);
    expect(chunkCountFor(CHUNK_SIZE_BYTES + 1)).toBe(2);
    expect(chunkCountFor(100 * 1024 * 1024)).toBe(Math.ceil((100 * 1024 * 1024) / CHUNK_SIZE_BYTES));
  });

  it("formate les tailles lisiblement", () => {
    expect(formatBytes(0)).toBe("0 o");
    expect(formatBytes(2048)).toBe("2 Ko");
    expect(formatBytes(100 * 1024 * 1024)).toBe("100 Mo");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2 Go");
  });
});
