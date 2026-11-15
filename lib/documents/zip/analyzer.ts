import yauzl from "yauzl";
import type { ArtifactFileEntry, ZipAnalysisResult } from "../types";
import {
  ARCHIVE_LIMITS,
  validateArchiveEntryCount,
  validateArchiveEntrySize,
  validateArchivePath,
} from "@/lib/security/archive-security";

const MAX_TEXT_EXTRACTION_PER_FILE = 10 * 1024 * 1024;
const MAX_TEXT_EXTRACTION_TOTAL = 25 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".csv", ".ts", ".tsx", ".js", ".jsx",
  ".mjs", ".cjs", ".py", ".java", ".go", ".rs", ".cpp", ".c", ".h", ".css",
  ".scss", ".html", ".xml", ".yaml", ".yml", ".env.example",
]);

function isTextFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return [...TEXT_EXTENSIONS].some((extension) => lower.endsWith(extension));
}

function isSymlink(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0xf000) === 0xa000;
}

function isEncrypted(entry: yauzl.Entry): boolean {
  return (entry.generalPurposeBitFlag & 0x0001) !== 0;
}

export async function analyzeZip(data: Buffer): Promise<ZipAnalysisResult> {
  if (data.length > ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new Error("ZIP input exceeds 100 MiB.");
  }

  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true, decodeStrings: true }, (error, zipFile) => {
      if (error || !zipFile) return reject(error ?? new Error("Unable to open ZIP archive."));

      const files: ArtifactFileEntry[] = [];
      const textFiles: Array<{ path: string; content: string }> = [];
      const warnings: string[] = [];
      const errors: string[] = [];
      const seenPaths = new Set<string>();
      let totalUncompressed = 0;
      let totalTextBytes = 0;
      let fileCount = 0;
      let finished = false;

      const finishUnsafe = (message: string) => {
        if (finished) return;
        finished = true;
        errors.push(message);
        try { zipFile.close(); } catch {}
        resolve({ safe: false, fileCount, totalUncompressedBytes: totalUncompressed, files, textFiles, warnings, errors });
      };

      zipFile.on("error", (zipError) => {
        if (!finished) reject(zipError);
      });

      zipFile.on("end", () => {
        if (finished) return;
        finished = true;
        resolve({
          safe: errors.length === 0,
          fileCount,
          totalUncompressedBytes: totalUncompressed,
          files,
          textFiles,
          warnings,
          errors,
        });
      });

      zipFile.on("entry", (entry) => {
        if (finished) return;

        const filename = entry.fileName;
        let safePath: string;
        try {
          safePath = validateArchivePath(filename);
        } catch {
          return finishUnsafe(`Unsafe ZIP path: ${filename}`);
        }

        if (isEncrypted(entry)) return finishUnsafe(`Encrypted ZIP entry is not allowed: ${filename}`);
        if (isSymlink(entry)) return finishUnsafe(`Symlink entry is not allowed: ${filename}`);
        if (seenPaths.has(safePath)) return finishUnsafe(`Duplicate ZIP path: ${safePath}`);
        seenPaths.add(safePath);

        fileCount += 1;
        try {
          validateArchiveEntryCount(fileCount);
        } catch {
          return finishUnsafe("ZIP contains too many entries.");
        }

        const isDirectory = filename.endsWith("/");
        const size = entry.uncompressedSize;
        const compressedSize = entry.compressedSize;

        try {
          validateArchiveEntrySize(size, compressedSize, totalUncompressed + size);
        } catch (entryError) {
          return finishUnsafe(entryError instanceof Error ? entryError.message : "Unsafe ZIP entry.");
        }

        totalUncompressed += size;
        files.push({
          path: safePath,
          type: isDirectory ? "directory" : isTextFile(filename) ? "text" : "binary",
          sizeBytes: size,
          compressedSizeBytes: compressedSize,
          isDirectory,
        });

        if (!isDirectory && isTextFile(filename) && size <= MAX_TEXT_EXTRACTION_PER_FILE) {
          if (totalTextBytes + size > MAX_TEXT_EXTRACTION_TOTAL) {
            warnings.push(`Text extraction limit reached; ${filename} was indexed as metadata only.`);
            zipFile.readEntry();
            return;
          }

          zipFile.openReadStream(entry, (streamError, stream) => {
            if (finished) return;
            if (streamError || !stream) {
              warnings.push(`Could not read ${filename}`);
              zipFile.readEntry();
              return;
            }

            const chunks: Buffer[] = [];
            let bytesRead = 0;
            let aborted = false;

            stream.on("data", (chunk: Buffer) => {
              bytesRead += chunk.length;
              if (bytesRead > MAX_TEXT_EXTRACTION_PER_FILE || totalTextBytes + bytesRead > MAX_TEXT_EXTRACTION_TOTAL) {
                aborted = true;
                stream.destroy(new Error("Text extraction limit exceeded."));
                return;
              }
              chunks.push(chunk);
            });

            stream.on("end", () => {
              if (finished) return;
              if (!aborted) {
                totalTextBytes += bytesRead;
                textFiles.push({ path: safePath, content: Buffer.concat(chunks).toString("utf8") });
              } else {
                warnings.push(`Text extraction limit reached; ${filename} was indexed as metadata only.`);
              }
              zipFile.readEntry();
            });

            stream.on("error", () => {
              if (!finished) {
                warnings.push(`Could not extract ${filename}`);
                zipFile.readEntry();
              }
            });
          });
          return;
        }

        zipFile.readEntry();
      });

      zipFile.readEntry();
    });
  });
}
