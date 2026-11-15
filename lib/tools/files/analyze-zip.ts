import { z } from "zod";
import type { ToolDefinition } from "../types";
import { analyzeZip } from "@/lib/documents/zip";
import { getArtifactRecord } from "@/lib/documents/artifact-repository";
import { downloadFromR2 } from "@/lib/storage/r2";

const inputSchema = z.object({
  dataBase64: z.string().min(1).max(140_000_000).optional(),
  artifactId: z.string().min(1).max(128).optional(),
  includeText: z.boolean().default(true),
}).refine((value) => Boolean(value.dataBase64 || value.artifactId), { message: "dataBase64 or artifactId is required" });

export const analyzeZipTool: ToolDefinition = {
  id: "zip.analyze",
  name: "zip.analyze",
  description: "Analyze a ZIP archive with path traversal, symlink, size and ZIP-bomb protections.",
  category: "files",
  risk: "low",
  inputSchema,
  execute: async (input, context) => {
    const parsed = inputSchema.parse(input);
    let data: Buffer;
    if (parsed.dataBase64) {
      data = Buffer.from(parsed.dataBase64, "base64");
    } else {
      const artifact = await getArtifactRecord(parsed.artifactId!);
      if (!artifact || artifact.ownerId !== context.userId) throw new Error("Artifact not found");
      if (artifact.size > 100 * 1024 * 1024) throw new Error("ZIP artifact exceeds 100 MiB");
      data = await downloadFromR2(artifact.storageKey, 100 * 1024 * 1024);
    }
    if (data.length > 100 * 1024 * 1024) throw new Error("ZIP input exceeds 100 MiB");
    const result = await analyzeZip(data);
    return {
      success: true,
      safe: result.safe,
      fileCount: result.fileCount,
      totalUncompressedBytes: result.totalUncompressedBytes,
      files: result.files,
      textFiles: parsed.includeText ? result.textFiles : [],
      warnings: result.warnings,
      errors: result.errors,
    };
  },
};
