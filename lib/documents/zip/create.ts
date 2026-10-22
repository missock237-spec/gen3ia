import { ZipArchive } from "archiver";
import { validateArchiveEntryCount, validateArchivePath, ARCHIVE_LIMITS } from "@/lib/security/archive-security";

export interface ZipEntry {
  filename: string;
  data: Buffer;
}

export async function createZip(entries: ZipEntry[]): Promise<Buffer> {
  if (!entries.length) {
    throw new Error("Cannot create an empty ZIP archive.");
  }

  validateArchiveEntryCount(entries.length);

  const seen = new Set<string>();
  let inputBytes = 0;

  for (const entry of entries) {
    const safePath = validateArchivePath(entry.filename);
    if (seen.has(safePath)) {
      throw new Error(`Duplicate ZIP path rejected: ${entry.filename}`);
    }
    seen.add(safePath);

    if (!Buffer.isBuffer(entry.data)) {
      throw new Error(`ZIP entry must be a Buffer: ${entry.filename}`);
    }
    if (entry.data.length > ARCHIVE_LIMITS.maxSingleFileBytes) {
      throw new Error(`ZIP entry exceeds the single-file limit: ${entry.filename}`);
    }
    inputBytes += entry.data.length;
    if (inputBytes > ARCHIVE_LIMITS.maxTotalUncompressedBytes) {
      throw new Error("ZIP content exceeds the total uncompressed limit.");
    }
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error("ZIP creation failed."));
    };

    const archive = new ZipArchive({
      zlib: { level: 9 },
    });

    archive.on("data", (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > ARCHIVE_LIMITS.maxArchiveBytes) {
        fail(new Error("Generated ZIP exceeds the archive size limit."));
        archive.abort();
        return;
      }
      chunks.push(chunk);
    });

    archive.on("error", fail);
    archive.on("warning", (warning) => {
      if ((warning as NodeJS.ErrnoException).code === "ENOENT") fail(warning);
    });
    archive.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });

    for (const entry of entries) {
      archive.append(entry.data, { name: validateArchivePath(entry.filename) });
    }

    archive.finalize().catch(fail);
  });
}
