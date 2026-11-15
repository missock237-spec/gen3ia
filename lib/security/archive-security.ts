import { createHash } from "node:crypto";
import path from "node:path";

export const ARCHIVE_LIMITS = {
  maxArchiveBytes: 100 * 1024 * 1024,
  maxEntries: 5_000,
  maxTotalUncompressedBytes: 500 * 1024 * 1024,
  maxSingleFileBytes: 100 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxPathDepth: 32,
  maxPathLength: 1_024,
} as const;

export function validateArchivePath(entryName: string): string {
  if (!entryName || entryName.length > ARCHIVE_LIMITS.maxPathLength || entryName.includes("\0")) throw new Error("Unsafe archive path.");
  const input = entryName.replace(/\\/g, "/");
  if (input.startsWith("/") || input.startsWith("//") || /^[A-Za-z]:\//.test(input)) throw new Error(`Unsafe archive path: ${entryName}`);
  const normalized = path.posix.normalize(input);
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length || segments.length > ARCHIVE_LIMITS.maxPathDepth || segments.some((segment) => segment === "..")) throw new Error(`Unsafe archive path: ${entryName}`);
  return segments.join("/");
}

export function validateArchiveEntryCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > ARCHIVE_LIMITS.maxEntries) throw new Error("Archive contains too many files.");
}

export function validateArchiveSize(totalUncompressedBytes: number): void {
  if (!Number.isSafeInteger(totalUncompressedBytes) || totalUncompressedBytes < 0 || totalUncompressedBytes > ARCHIVE_LIMITS.maxTotalUncompressedBytes) throw new Error("Archive uncompressed size exceeds security limit.");
}

export function validateArchiveEntrySize(uncompressedBytes: number, compressedBytes: number, totalAfterEntry: number): void {
  if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes < 0 || uncompressedBytes > ARCHIVE_LIMITS.maxSingleFileBytes) throw new Error("Archive entry exceeds the single-file limit.");
  if (!Number.isSafeInteger(compressedBytes) || compressedBytes < 0) throw new Error("Invalid archive compression metadata.");
  if (compressedBytes === 0 && uncompressedBytes > 0) throw new Error("Invalid archive compression metadata.");
  if (compressedBytes > 0 && uncompressedBytes / compressedBytes > ARCHIVE_LIMITS.maxCompressionRatio) throw new Error("Archive compression ratio is unsafe.");
  validateArchiveSize(totalAfterEntry);
}

export function archiveContentHash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
