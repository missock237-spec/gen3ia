import { z } from "zod";

export const ArtifactFormatSchema = z.enum([
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "csv",
  "md",
  "txt",
  "json",
  "html",
  "zip",
]);

export type ArtifactFormat = z.infer<typeof ArtifactFormatSchema>;

export const ArtifactOperationSchema = z.enum([
  "create",
  "analyze",
  "extract",
  "package",
]);

export type ArtifactOperation = z.infer<typeof ArtifactOperationSchema>;

export const DocumentBlockSchema = z.object({
  type: z.enum([
    "title",
    "heading",
    "paragraph",
    "list",
    "table",
    "code",
    "quote",
    "image",
    "pageBreak",
  ]),

  text: z.string().optional(),

  level: z.number().int().min(1).max(6).optional(),

  ordered: z.boolean().optional(),

  items: z.array(z.string()).optional(),

  columns: z.array(z.string()).optional(),

  rows: z.array(z.array(z.string())).optional(),

  language: z.string().optional(),

  url: z.string().url().optional(),
});

export type DocumentBlock = z.infer<typeof DocumentBlockSchema>;

export const DocumentPlanSchema = z.object({
  title: z.string().min(1).max(300),

  format: ArtifactFormatSchema,

  description: z.string().max(5000).optional(),

  blocks: z.array(DocumentBlockSchema).min(1),

  metadata: z.record(z.string(), z.string()).optional(),
});

export type DocumentPlan = z.infer<typeof DocumentPlanSchema>;

/* ------------------------------------------------------------------ */
/* SANITIZER (Task 114) — tolérance aux écarts de format du LLM        */
/* ------------------------------------------------------------------ */

/** Alias courants des types de blocs inventés par les modèles. */
const BLOCK_TYPE_ALIASES: Record<string, DocumentBlock["type"]> = {
  text: "paragraph", para: "paragraph", p: "paragraph", content: "paragraph",
  title: "title", titre: "title", h1: "title", mainTitle: "title",
  heading: "heading", subtitle: "heading", soustitre: "heading", section: "heading",
  h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
  list: "list", bullets: "list", bullet: "list", ul: "list", ol: "list", puces: "list", listitems: "list",
  table: "table", tableau: "table",
  code: "code", snippet: "code", codesnippet: "code",
  quote: "quote", citation: "quote",
  image: "image", img: "image", picture: "image", photo: "image",
  pagebreak: "pageBreak", page: "pageBreak", break: "pageBreak", saut: "pageBreak", sautpage: "pageBreak",
};

/** Normalise une URL : « www.x » → « https://www.x », invalide → undefined. */
function urlNormalisee(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let u = value.trim();
  if (!u) return undefined;
  if (/^www\./i.test(u)) u = `https://${u}`;
  return /^https?:\/\/\S+$/i.test(u) ? u : undefined;
}

function texteBorné(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  const t = s.trim();
  return t ? t.slice(0, 20_000) : undefined;
}

function chaineListe(items: unknown): string[] | undefined {
  if (!Array.isArray(items)) return undefined;
  const out = items
    .map((x) => texteBorné(x))
    .filter((x): x is string => Boolean(x))
    .slice(0, 500);
  return out.length > 0 ? out : undefined;
}

/** Coercition d'un bloc brut vers un DocumentBlock valide (jamais d'exception). */
function blocSanitisé(raw: unknown): DocumentBlock | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    const text = raw.trim().slice(0, 20_000);
    return text ? ({ type: "paragraph", text } as DocumentBlock) : null;
  }
  if (typeof raw !== "object") {
    const text = texteBorné(raw);
    return text ? ({ type: "paragraph", text } as DocumentBlock) : null;
  }
  const src = raw as Record<string, unknown>;
  const rawType = String(src.type ?? "paragraph").trim();
  const normalisé = rawType.toLowerCase().replace(/[\s_-]/g, "");
  const type = BLOCK_TYPE_ALIASES[normalisé] ?? "paragraph";
  const block: Record<string, unknown> = { type };

  const text = texteBorné(src.text) ?? texteBorné(src.content) ?? texteBorné(src.value);
  if (text) block.text = text;

  if (src.level !== undefined) {
    const n = Number(src.level);
    if (Number.isFinite(n)) block.level = Math.min(6, Math.max(1, Math.round(n)));
  }
  if (typeof src.ordered === "boolean") block.ordered = src.ordered;

  const items = chaineListe(src.items);
  if (items) block.items = items;
  const columns = chaineListe(src.columns);
  if (columns) block.columns = columns;
  if (Array.isArray(src.rows)) {
    const rows = src.rows
      .map((row) => (Array.isArray(row) ? chaineListe(row) : undefined))
      .filter((row): row is string[] => Boolean(row))
      .slice(0, 500);
    if (rows.length > 0) block.rows = rows;
  }

  const url = urlNormalisee(src.url) ?? urlNormalisee(src.src) ?? urlNormalisee(src.href);
  if (url) block.url = url;

  if ((block.type === "paragraph" || block.type === "quote") && !block.text && items) {
    block.text = items.join(" • ");
  }
  if (block.type === "list" && !block.items && text) {
    block.items = text.split(/\n+/).map((line) => line.replace(/^[-*•]\s*/, "")).filter(Boolean).slice(0, 500);
  }
  if ((block.type === "title" || block.type === "heading") && !block.text && typeof src.name === "string") {
    block.text = texteBorné(src.name);
  }
  return block as DocumentBlock;
}

/**
 * Coercition tolérante d'un plan de document produit par un LLM : types de
 * blocs inconnus ramenés à « paragraph », URLs réparées, champs typés
 * nettoyés, bloc vide garanti. Objectif : un écart de format du modèle ne
 * fait JAMAIS échouer la mission (exigence « résultat plutôt qu'échec »).
 */
export function sanitizeDocumentPlan(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const src = { ...(raw as Record<string, unknown>) };
  if (typeof src.title !== "string" || !src.title.trim()) {
    src.title = typeof src.name === "string" && src.name.trim() ? src.name.trim().slice(0, 300) : "Document";
  }
  if (src.format === undefined && typeof src.type === "string") src.format = src.type;
  const blocksRaw = Array.isArray(src.blocks) ? src.blocks : Array.isArray(src.content) ? src.content : [];
  let blocks = blocksRaw.map(blocSanitisé).filter((b): b is DocumentBlock => Boolean(b));
  if (blocks.length === 0) {
    const fallback = texteBorné(src.description) ?? "Document généré.";
    blocks = [{ type: "paragraph", text: fallback } as DocumentBlock];
  }
  src.blocks = blocks.slice(0, 400);
  return src;
}



/** Alias de formats LLM → formats canoniques (partagé runner + outil). */
const FORMAT_ALIASES: Record<string, string> = {
  word: "docx", doc: "docx", document: "docx",
  excel: "xlsx", xls: "xlsx", spreadsheet: "xlsx", tableur: "xlsx",
  powerpoint: "pptx", ppt: "pptx", slides: "pptx", presentation: "pptx", "présentation": "pptx",
  markdown: "md",
  text: "txt", texte: "txt", plain: "txt",
  web: "html",
};

function formatCanonique(value: unknown): string {
  const s = String(value ?? "pdf").trim().toLowerCase().replace(/^\./, "");
  if (FORMAT_ALIASES[s]) return FORMAT_ALIASES[s];
  return ["pdf", "docx", "xlsx", "pptx", "csv", "md", "txt", "json", "html"].includes(s) ? s : "pdf";
}

/**
 * Préparation complète de l'entrée de l'outil artifact.create (Task 114) :
 * coercition de format + sanitizeDocumentPlan. À appliquer AVANT toute
 * validation par le schéma de l'outil — notamment dans le runner (l'entrée
 * est validée par lib/tools/executor AVANT tool.execute, une sanitisation
 * uniquement DANS l'outil serait trop tardive).
 */
export function sanitizeArtifactToolInput(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const base = input && typeof input === "object" ? { ...input } : {};
  return sanitizeDocumentPlan({ ...base, format: formatCanonique(base.format) }) as Record<string, unknown>;
}

export const ArtifactInputSchema = z.object({
  filename: z.string().min(1).max(255),

  mimeType: z.string().optional(),

  sizeBytes: z.number().int().nonnegative().optional(),

  storagePath: z.string().optional(),
});

export const ArtifactValidationSchema = z.object({
  valid: z.boolean(),

  format: ArtifactFormatSchema,

  sizeBytes: z.number().int().nonnegative(),

  mimeType: z.string(),

  errors: z.array(z.string()),

  warnings: z.array(z.string()),
});

export type ArtifactValidation = z.infer<
  typeof ArtifactValidationSchema
>;

export interface DocumentRequest {
  title: string;

  content: string;

  format: "docx" | "pdf" | "txt" | "md";
}

export interface GeneratedDocument {
  filename: string;

  mimeType: string;

  buffer: Buffer;

  size: number;
}

export interface GeneratedArtifact {
  artifactId: string;

  userId: string;

  projectId?: string;

  executionId?: string;

  filename: string;

  format: ArtifactFormat;

  mimeType: string;

  sizeBytes: number;

  storagePath: string;

  downloadUrl?: string;

  createdAt: string;

  validation: ArtifactValidation;
}

export interface ArtifactAnalysis {
  artifactId: string;

  filename: string;

  format: ArtifactFormat;

  mimeType: string;

  sizeBytes: number;

  safe: boolean;

  files?: ArtifactFileEntry[];

  extractedText?: string;

  summary?: string;

  warnings: string[];

  errors: string[];

  metadata?: Record<string, unknown>;
}

export interface ArtifactFileEntry {
  path: string;

  type: string;

  sizeBytes: number;

  compressedSizeBytes?: number;

  isDirectory: boolean;
}

export interface ZipAnalysisResult {
  safe: boolean;

  fileCount: number;

  totalUncompressedBytes: number;

  files: ArtifactFileEntry[];

  textFiles: Array<{
    path: string;
    content: string;
  }>;

  warnings: string[];

  errors: string[];
} 
