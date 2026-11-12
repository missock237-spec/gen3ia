import { describe, expect, it } from "vitest";

import {
  ACCEPT_ATTRIBUTE,
  MAX_FILE_BYTES,
  PART_SIZE_BYTES,
  chunkCountFor,
  formatBytes,
  isExtensionAllowed,
  MAX_FILES_PER_BATCH,
  MAX_USER_QUOTA_BYTES,
  sanitizeFilename,
  validateSingleUpload,
  validateUploadBatch,
} from "./upload-policy";

const MO = 1024 * 1024;

describe("upload policy", () => {
  it("fixe les bornes de production : 15 fichiers × 100 Mo, quota socle 4 Go", () => {
    expect(MAX_FILE_BYTES).toBe(100 * MO);
    expect(MAX_FILES_PER_BATCH).toBe(15);
    expect(MAX_USER_QUOTA_BYTES).toBe(4 * 1024 ** 3);
  });

  it("accepte un lot de fichiers valides", () => {
    const result = validateUploadBatch([
      { filename: "rapport.pdf", contentType: "application/pdf", sizeBytes: 5 * MO },
      { filename: "notes.md", contentType: "text/markdown", sizeBytes: 2048 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intents).toHaveLength(2);
      expect(result.totalBytes).toBe(5 * MO + 2048);
      expect(result.intents[0]?.extension).toBe("pdf");
    }
  });

  it("accepte EXACTEMENT 15 fichiers en un lot (demande : 15 × 100 Mo simultanés)", () => {
    const files = Array.from({ length: MAX_FILES_PER_BATCH }, (_, i) => ({
      filename: `gros-${i}.zip`,
      contentType: "application/zip",
      sizeBytes: 100 * MO,
    }));
    const result = validateUploadBatch(files);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intents).toHaveLength(15);
      expect(result.totalBytes).toBe(15 * 100 * MO);
    }
  });

  it("rejette un lot de plus de 15 fichiers", () => {
    const files = Array.from({ length: MAX_FILES_PER_BATCH + 1 }, (_, i) => ({
      filename: `f${i}.txt`,
      contentType: "text/plain",
      sizeBytes: 10,
    }));
    const result = validateUploadBatch(files);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections[0]?.reason).toContain(`Maximum ${MAX_FILES_PER_BATCH}`);
  });

  it("accepte un fichier de 100 Mo pile à la limite", () => {
    const lot = validateUploadBatch([
      { filename: "video.mp4", contentType: "video/mp4", sizeBytes: 100 * MO },
    ]);
    expect(lot.ok).toBe(true);
    const iso = validateSingleUpload({ filename: "video.mp4", contentType: "video/mp4", sizeBytes: 100 * MO });
    expect(iso.ok).toBe(true);
  });

  it("rejette un fichier de 100 Mo + 1 octet avec un message lisible", () => {
    const lot = validateUploadBatch([
      { filename: "video.mp4", contentType: "video/mp4", sizeBytes: 100 * MO + 1 },
    ]);
    expect(lot.ok).toBe(false);
    if (!lot.ok) expect(lot.rejections[0]?.reason).toContain("100 Mo");
    const iso = validateSingleUpload({ filename: "video.mp4", contentType: "video/mp4", sizeBytes: 100 * MO + 1 });
    expect(iso.ok).toBe(false);
    if (!iso.ok) expect(iso.reason).toContain("100 Mo");
  });

  it("rejette un fichier de plus de 100 Mo", () => {
    const result = validateUploadBatch([
      { filename: "gros.zip", contentType: "application/zip", sizeBytes: 101 * MO },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections[0]?.reason).toContain("trop volumineux");
  });

  it("valide un lot MIXTE : gros fichiers + petits + un invalide", () => {
    const result = validateUploadBatch([
      { filename: "archive.zip", contentType: "application/zip", sizeBytes: 100 * MO },
      { filename: "note.md", contentType: "text/markdown", sizeBytes: 1024 },
      { filename: "photo.heic", contentType: "image/heic", sizeBytes: 12 * MO },
      { filename: "virus.exe", contentType: "application/x-msdownload", sizeBytes: 3 * MO },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejections).toHaveLength(1);
      expect(result.rejections[0]?.index).toBe(3);
      expect(result.rejections[0]?.reason).toContain("non autorise");
    }
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
      { alreadyUsedBytes: 5 * 1024 * 1024 * 1024 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections[0]?.reason).toContain("Quota");
  });

  it("applique le quota du plan (4 Go socle / 5 Go / 10 Go) quand il est fourni — Task 150", () => {
    // 5 Go utilisés : dépasse le socle free (4 Go) mais PAS un lot 5 Go + marge.
    const free = validateUploadBatch(
      [{ filename: "a.pdf", contentType: "application/pdf", sizeBytes: 10 * 1024 * 1024 }],
      { alreadyUsedBytes: 5 * 1024 ** 3 },
    );
    expect(free.ok).toBe(false);
    if (!free.ok) expect(free.rejections[0]?.reason).toContain("4 Go");

    // Un lot de 15 × 100 Mo (1,5 Go) tient DANS le socle free de 4 Go.
    const plein = validateUploadBatch(
      Array.from({ length: 15 }, (_, i) => ({
        filename: `gros-${i}.zip`,
        contentType: "application/zip",
        sizeBytes: 100 * 1024 * 1024,
      })),
    );
    expect(plein.ok).toBe(true);

    const pro5 = validateUploadBatch(
      [{ filename: "a.pdf", contentType: "application/pdf", sizeBytes: 10 * 1024 * 1024 }],
      { alreadyUsedBytes: 5 * 1024 ** 3, quotaBytes: 5 * 1024 ** 3 },
    );
    expect(pro5.ok).toBe(false);

    // Le quota paramétré borne aussi les plans 10 Go.
    const pro10 = validateUploadBatch(
      [{ filename: "a.zip", contentType: "application/zip", sizeBytes: 100 * 1024 * 1024 }],
      { alreadyUsedBytes: 9.95 * 1024 ** 3, quotaBytes: 10 * 1024 ** 3 },
    );
    expect(pro10.ok).toBe(false);
  });

  it("calcule le nombre de chunks", () => {
    expect(chunkCountFor(0)).toBe(0);
    expect(chunkCountFor(1)).toBe(1);
    expect(chunkCountFor(PART_SIZE_BYTES)).toBe(1);
    expect(chunkCountFor(PART_SIZE_BYTES + 1)).toBe(2);
    expect(chunkCountFor(100 * MO)).toBe(Math.ceil((100 * MO) / PART_SIZE_BYTES));
  });

  it("formate les tailles lisiblement", () => {
    expect(formatBytes(0)).toBe("0 o");
    expect(formatBytes(2048)).toBe("2 Ko");
    expect(formatBytes(100 * MO)).toBe("100 Mo");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2 Go");
  });

  it("valide un fichier isole sans annuler le lot", () => {
    const good = validateSingleUpload({ filename: "rapport.txt", contentType: "text/plain", sizeBytes: 128 });
    expect(good.ok).toBe(true);
    const bad = validateSingleUpload({ filename: "virus.exe", contentType: "application/x-msdownload", sizeBytes: 128 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("non autorise");
    const vide = validateSingleUpload({ filename: "vide.pdf", contentType: "application/pdf", sizeBytes: 0 });
    expect(vide.ok).toBe(false);
    if (!vide.ok) expect(vide.reason).toContain("vide");
  });
});

describe("ACCEPT_ATTRIBUTE — sélecteur dérivé de la politique serveur", () => {
  it("couvre les génériques multimédias et les documents bureautiques", () => {
    // Les multimédias passent par les génériques image/* audio/* video/* ;
    // les documents, données et code par des extensions explicites.
    for (const morceau of ["image/*", "audio/*", "video/*", ".pdf", ".docx", ".zip", ".txt", ".csv", ".json", ".odt", ".ods", ".pptx", ".epub", ".rtf", ".py", ".ts"]) {
      expect(ACCEPT_ATTRIBUTE).toContain(morceau);
    }
  });

  it("n'expose aucune extension bloquée et aucun doublon", () => {
    for (const interdite of [".exe", ".dll", ".bat", ".msi", ".sh", ".iso"]) {
      expect(ACCEPT_ATTRIBUTE).not.toContain(interdite);
    }
    const parties = ACCEPT_ATTRIBUTE.split(",");
    expect(new Set(parties).size).toBe(parties.length);
  });
});
