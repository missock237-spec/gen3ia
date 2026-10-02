import { z } from "zod";
import type { ToolDefinition } from "../types";
import { createZip } from "@/lib/documents/zip";
import { storeArtifactBuffer } from "@/lib/documents/artifact-store";
import { assertWorkspaceOwner } from "@/lib/execution/workspace-registry";
import { sanitizeArchivePath } from "@/lib/documents/zip/path-security";
import path from "node:path";
import fs from "node:fs/promises";

const MAX_FILES = 10_000;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_SINGLE_FILE = 100 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

const inputSchema = z.object({
  workspaceId: z.string().min(1).max(128).optional(),
  filename: z.string().min(1).max(255).default("gen3ia-output.zip"),
  files: z.array(
    z.object({
      filename: z.string().min(1).max(1024),
      dataBase64: z.string().min(1).max(140_000_000),
    }),
  ).max(MAX_FILES).optional(),
}).refine((value) => Boolean(value.workspaceId || value.files?.length), {
  message: "workspaceId or files is required",
});

function safeOutputName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 255) || "gen3ia-output.zip";
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid base64 file payload");
  }
  const data = Buffer.from(value, "base64");
  if (data.length === 0) throw new Error("Decoded file payload is empty");
  return data;
}

function assertUniquePaths(entries: Array<{ filename: string }>): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.filename)) throw new Error(`Duplicate ZIP path: ${entry.filename}`);
    seen.add(entry.filename);
  }
}

async function readWorkspaceFiles(workspaceRoot: string) {
  const entries: Array<{ filename: string; data: Buffer }> = [];
  let totalBytes = 0;

  async function walk(current: string, relativeRoot: string) {
    const children = await fs.readdir(current, { withFileTypes: true });
    for (const child of children) {
      if (entries.length >= MAX_FILES) throw new Error(`Workspace contains more than ${MAX_FILES} files`);
      const absolute = path.join(current, child.name);
      const relative = path.posix.join(relativeRoot, child.name);
      const safePath = sanitizeArchivePath(relative);
      // Le type est lu depuis readdir (getdents, avecFileTypes) : PAS de
      // lstat dédié = plus aucune paire stat→open analysable comme course.
      // Les liens symboliques sont rejetés ici ET par O_NOFOLLOW à l'ouverture
      // (double barrière), puis l'inode vérifié par fstat sur descripteur.
      if (child.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in ZIP workspaces: ${safePath}`);
      if (child.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (!child.isFile()) continue;
      // Lecture par descripteur ouvert SANS suivi de lien symbolique
      // (O_NOFOLLOW) puis statistiques sur le DESCRIPTEUR : la fenêtre
      // TOCTOU entre lstat et readFile (alerte CodeQL file-system-race —
      // un fichier substitué par un lien symbolique entre les deux appels)
      // est fermée : les données lues proviennent exactement de l'inode
      // vérifié (type + taille), jamais d'un chemin re-résolu.
      const handle = await fs.open(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (opened.isSymbolicLink() || !opened.isFile()) continue;
        if (opened.size > MAX_SINGLE_FILE) throw new Error(`File exceeds ${MAX_SINGLE_FILE} bytes: ${safePath}`);
        totalBytes += opened.size;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Workspace exceeds ZIP uncompressed size limit");
        const data = Buffer.alloc(opened.size);
        let read = 0;
        while (read < opened.size) {
          const { bytesRead } = await handle.read(data, read, opened.size - read, read);
          if (bytesRead <= 0) throw new Error(`File truncated while reading: ${safePath}`);
          read += bytesRead;
        }
        entries.push({ filename: safePath, data });
      } finally {
        await handle.close();
      }
    }
  }

  await walk(workspaceRoot, "");
  if (!entries.length) throw new Error("Workspace contains no files");
  assertUniquePaths(entries);
  return entries;
}

export const createZipTool: ToolDefinition = {
  id: "zip.create",
  name: "zip.create",
  description: "Create and persist a secure ZIP artifact from agent files or an authenticated execution workspace.",
  category: "files",
  risk: "medium",
  inputSchema,
  execute: async (input, context) => {
    const parsed = inputSchema.parse(input);
    let entries: Array<{ filename: string; data: Buffer }>;

    if (parsed.workspaceId) {
      const workspace = assertWorkspaceOwner(parsed.workspaceId, context.userId);
      entries = await readWorkspaceFiles(workspace.root);
    } else {
      entries = parsed.files!.map((file) => ({
        filename: sanitizeArchivePath(file.filename),
        data: decodeBase64(file.dataBase64),
      }));
      assertUniquePaths(entries);
      let total = 0;
      for (const entry of entries) {
        if (entry.data.length > MAX_SINGLE_FILE) throw new Error(`File exceeds ${MAX_SINGLE_FILE} bytes: ${entry.filename}`);
        total += entry.data.length;
        if (total > MAX_TOTAL_BYTES) throw new Error("ZIP input exceeds uncompressed size limit");
      }
    }

    const data = await createZip(entries);
    if (data.length > MAX_ARCHIVE_BYTES) throw new Error("Generated ZIP exceeds 100 MiB");

    const artifact = await storeArtifactBuffer({
      ownerId: context.userId,
      executionId: context.executionId ?? "unknown",
      name: safeOutputName(parsed.filename),
      mimeType: "application/zip",
      data,
    });

    return {
      success: true,
      artifactId: artifact.artifactId,
      filename: artifact.name,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.size,
      checksum: artifact.checksum,
      storageKey: artifact.storageKey,
    };
  },
};
