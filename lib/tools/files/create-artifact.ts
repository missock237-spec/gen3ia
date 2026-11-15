import { z } from "zod";
import type { ToolDefinition } from "../types";
import { generateArtifact } from "@/lib/documents/engine";
import { sanitizeDocumentPlan } from "@/lib/documents/types";
import { storeArtifactBuffer } from "@/lib/documents/artifact-store";

const inputSchema = z.object({
  title: z.string().min(1).max(300),
  format: z.enum(["pdf", "docx", "xlsx", "pptx", "csv", "md", "txt", "json", "html"]),
  blocks: z.array(
    z.object({
      type: z.enum(["title", "heading", "paragraph", "list", "table", "code", "quote", "image", "pageBreak"]),
      text: z.string().max(1_000_000).optional(),
      level: z.number().int().min(1).max(6).optional(),
      ordered: z.boolean().optional(),
      items: z.array(z.string().max(100_000)).max(10_000).optional(),
      columns: z.array(z.string().max(10_000)).max(1_000).optional(),
      rows: z.array(z.array(z.string().max(10_000)).max(1_000)).max(10_000).optional(),
      language: z.string().max(100).optional(),
      url: z.string().url().optional(),
    }),
  ).min(1).max(10_000),
});

/** Alias de formats inventés par les LLM → formats canoniques (Task 114). */
const FORMAT_ALIASES: Record<string, string> = {
  word: "docx", doc: "docx", document: "docx",
  excel: "xlsx", xls: "xlsx", spreadsheet: "xlsx", tableur: "xlsx",
  powerpoint: "pptx", ppt: "pptx", slides: "pptx", presentation: "pptx", présentation: "pptx",
  markdown: "md",
  text: "txt", texte: "txt", plain: "txt",
  web: "html",
};

function formatCanonique(value: unknown): string {
  const s = String(value ?? "pdf").trim().toLowerCase().replace(/^\./, "");
  if (FORMAT_ALIASES[s]) return FORMAT_ALIASES[s];
  return ["pdf", "docx", "xlsx", "pptx", "csv", "md", "txt", "json", "html"].includes(s) ? s : "pdf";
}

export const createArtifactTool: ToolDefinition = {
  id: "artifact.create",
  name: "artifact.create",
  description: "Generate, validate and persist a document artifact in the authenticated user's private R2 storage.",
  category: "files",
  risk: "medium",
  inputSchema,
  execute: async (input, context) => {
    // SANITIZER (Task 114) : un écart de format du LLM (type de bloc
    // inventé, URL malformée, format « word »/« presentation ») ne fait
    // JAMAIS échouer l'outil — coercition d'abord, validation ensuite.
    const parsed = inputSchema.parse(
      sanitizeDocumentPlan({ ...(input as Record<string, unknown>), format: formatCanonique((input as Record<string, unknown>).format) }),
    );
    const generated = await generateArtifact({
      userId: context.userId,
      projectId: context.projectId,
      executionId: context.executionId,
      plan: {
        title: parsed.title,
        format: parsed.format,
        blocks: parsed.blocks,
      },
    });

    const artifact = await storeArtifactBuffer({
      ownerId: context.userId,
      executionId: context.executionId ?? "unknown",
      name: generated.filename,
      mimeType: generated.mimeType,
      data: generated.data,
    });

    return {
      success: true,
      artifactId: artifact.artifactId,
      filename: artifact.name,
      format: generated.format,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.size,
      checksum: artifact.checksum,
      storageKey: artifact.storageKey,
      validation: generated.validation,
    };
  },
};
