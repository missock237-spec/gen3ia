import { randomUUID } from "node:crypto";
import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import yauzl from "yauzl";
import { z } from "zod";
import type { ToolDefinition } from "../types";
import { getArtifactRecord } from "@/lib/documents/artifact-repository";
import { downloadFromR2 } from "@/lib/storage/r2";
import { sanitizeArchivePath } from "@/lib/documents/zip/path-security";
import { assertWorkspaceOwner } from "@/lib/execution/workspace-registry";
import {
  ARCHIVE_LIMITS,
  validateArchiveEntryCount,
  validateArchiveEntrySize,
} from "@/lib/security/archive-security";

const inputSchema = z.object({
  artifactId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  destination: z.string().min(1).max(256).default("extracted"),
});

function validateDestination(destination: string): string {
  return sanitizeArchivePath(destination.replace(/\\/g, "/").replace(/\/$/, ""));
}

function isSymlink(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0xf000) === 0xa000;
}

function isEncrypted(entry: yauzl.Entry): boolean {
  return (entry.generalPurposeBitFlag & 0x0001) !== 0;
}

function streamEntryToFile(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  target: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`Unable to read ZIP entry: ${entry.fileName}`));
        return;
      }

      const output = createWriteStream(target, { flags: "wx", mode: 0o600 });
      let settled = false;
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const fail = (reason: Error) => {
        if (settled) return;
        settled = true;
        stream.destroy();
        output.destroy();
        cleanup();
        void fs.rm(target, { force: true }).finally(() => reject(reason));
      };
      const onAbort = () => fail(new Error("ZIP extraction cancelled"));

      signal?.addEventListener("abort", onAbort, { once: true });
      output.on("error", fail);
      stream.on("error", fail);
      output.on("finish", () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      });
      stream.pipe(output);
    });
  });
}

async function assertNoSymlinkComponents(root: string, relativePath: string): Promise<void> {
  const segments = relativePath.split("/").filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Symlink path component is not allowed: ${relativePath}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw error;
    }
  }
}

export const extractZipTool: ToolDefinition = {
  id: "zip.extract",
  name: "zip.extract",
  description: "Securely extract an owned ZIP artifact into an owned execution workspace with traversal, symlink, encryption, duplicate-path, size and ZIP-bomb protections.",
  category: "files",
  risk: "medium",
  inputSchema,
  execute: async (input, context) => {
    const parsed = inputSchema.parse(input);
    const workspace = await assertWorkspaceOwner(parsed.workspaceId, context.userId);
    const artifact = await getArtifactRecord(parsed.artifactId);

    if (!artifact || artifact.ownerId !== context.userId) throw new Error("Artifact not found");
    if (artifact.mimeType !== "application/zip") throw new Error("Artifact is not a ZIP archive");
    if (artifact.size > ARCHIVE_LIMITS.maxArchiveBytes) throw new Error("ZIP artifact exceeds 100 MiB");

    const archive = await downloadFromR2(artifact.storageKey, ARCHIVE_LIMITS.maxArchiveBytes);
    if (archive.length > ARCHIVE_LIMITS.maxArchiveBytes) throw new Error("ZIP archive exceeds 100 MiB");

    const destination = validateDestination(parsed.destination);
    const extractionId = `zip-${randomUUID()}`;
    const extractionRoot = path.resolve(workspace.root, destination, extractionId);
    const workspaceRoot = path.resolve(workspace.root);
    if (!(extractionRoot === workspaceRoot || extractionRoot.startsWith(`${workspaceRoot}${path.sep}`))) {
      throw new Error("Extraction destination escapes workspace");
    }

    await fs.mkdir(extractionRoot, { recursive: true, mode: 0o700 });

    try {
      await new Promise<void>((resolve, reject) => {
        yauzl.fromBuffer(archive, { lazyEntries: true, decodeStrings: true }, (openError, zipFile) => {
          if (openError || !zipFile) {
            reject(openError ?? new Error("Unable to open ZIP archive"));
            return;
          }

          let count = 0;
          let total = 0;
          const seen = new Set<string>();
          let finished = false;

          const fail = (error: Error) => {
            if (finished) return;
            finished = true;
            try { zipFile.close(); } catch {}
            reject(error);
          };

          zipFile.on("error", (error) => fail(error));
          zipFile.on("end", () => {
            if (finished) return;
            finished = true;
            resolve();
          });

          zipFile.on("entry", (entry) => {
            if (finished) return;
            void (async () => {
              const safePath = sanitizeArchivePath(entry.fileName);
              if (seen.has(safePath)) throw new Error(`Duplicate ZIP path: ${safePath}`);
              seen.add(safePath);
              if (isEncrypted(entry)) throw new Error(`Encrypted ZIP entry is not allowed: ${entry.fileName}`);
              if (isSymlink(entry)) throw new Error(`Symlink entry is not allowed: ${entry.fileName}`);

              count += 1;
              validateArchiveEntryCount(count);

              const size = entry.uncompressedSize;
              const compressedSize = entry.compressedSize;
              validateArchiveEntrySize(size, compressedSize, total + size);
              total += size;

              const target = path.resolve(extractionRoot, safePath);
              if (!(target === extractionRoot || target.startsWith(`${extractionRoot}${path.sep}`))) {
                throw new Error(`Unsafe extraction path: ${safePath}`);
              }

              if (entry.fileName.endsWith("/")) {
                await fs.mkdir(target, { recursive: true, mode: 0o700 });
              } else {
                await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
                await assertNoSymlinkComponents(extractionRoot, safePath);
                await streamEntryToFile(zipFile, entry, target, context.signal);
              }

              if (!finished) zipFile.readEntry();
            })().catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
          });

          zipFile.readEntry();
        });
      });

      return {
        success: true,
        artifactId: parsed.artifactId,
        workspaceId: parsed.workspaceId,
        extractionId,
        path: path.relative(workspaceRoot, extractionRoot).replace(/\\/g, "/"),
      };
    } catch (error) {
      await fs.rm(extractionRoot, { recursive: true, force: true });
      throw error;
    }
  },
};
