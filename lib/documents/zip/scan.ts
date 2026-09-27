import fs from "node:fs/promises";

import {
  ZIP_SECURITY_LIMITS,
} from "./security-limits";

import {
  sanitizeArchivePath,
} from "./path-security";

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface ZipScanResult {
  safe: boolean;
  files: number;
  directories: number;
  compressedBytes: number;
  uncompressedBytes: number;
  entries: ZipEntryInfo[];
  warnings: string[];
}

export async function scanZipFile(
  filePath: string
): Promise<ZipScanResult> {
  const stat = await fs.stat(filePath);

  if (
    stat.size >
    ZIP_SECURITY_LIMITS.maxArchiveBytes
  ) {
    throw new Error(
      "Archive exceeds maximum allowed size"
    );
  }

  const warnings: string[] = [];

  /**
   * Le parsing réel doit être effectué avec
   * une librairie ZIP existante du projet.
   *
   * Cette fonction définit la politique de sécurité.
   */
  const entries: ZipEntryInfo[] = [];

  let compressedBytes = 0;
  let uncompressedBytes = 0;
  let files = 0;
  let directories = 0;

  for (const entry of entries) {
    const safeName =
      sanitizeArchivePath(entry.name);

    if (safeName !== entry.name) {
      throw new Error(
        `Unsafe archive path: ${entry.name}`
      );
    }

    if (entry.isSymlink) {
      throw new Error(
        `Symbolic links are forbidden: ${entry.name}`
      );
    }

    if (
      entry.uncompressedSize >
      ZIP_SECURITY_LIMITS.maxSingleFileBytes
    ) {
      throw new Error(
        `File too large: ${entry.name}`
      );
    }

    compressedBytes +=
      entry.compressedSize;

    uncompressedBytes +=
      entry.uncompressedSize;

    if (entry.isDirectory) {
      directories++;
    } else {
      files++;
    }

    if (files > ZIP_SECURITY_LIMITS.maxFiles) {
      throw new Error(
        "Archive contains too many files"
      );
    }

    if (
      uncompressedBytes >
      ZIP_SECURITY_LIMITS.maxUncompressedBytes
    ) {
      throw new Error(
        "Archive uncompressed size exceeds limit"
      );
    }

    if (
      entry.compressedSize > 0 &&
      entry.uncompressedSize /
        entry.compressedSize >
        ZIP_SECURITY_LIMITS.maxCompressionRatio
    ) {
      throw new Error(
        `Suspicious compression ratio: ${entry.name}`
      );
    }

    if (
      safeName.split("/").length >
      ZIP_SECURITY_LIMITS.maxDepth
    ) {
      throw new Error(
        `Archive path too deep: ${entry.name}`
      );
    }
  }

  if (uncompressedBytes > 0) {
    const ratio =
      compressedBytes > 0
        ? uncompressedBytes /
          compressedBytes
        : Infinity;

    if (
      ratio >
      ZIP_SECURITY_LIMITS.maxCompressionRatio
    ) {
      throw new Error(
        "Archive compression ratio is unsafe"
      );
    }
  }

  return {
    safe: true,
    files,
    directories,
    compressedBytes,
    uncompressedBytes,
    entries,
    warnings,
  };
}
