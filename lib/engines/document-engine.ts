import "server-only";
import { z } from "zod";
import { generateArtifact } from "@/lib/documents/engine";
import { storeArtifactBuffer } from "@/lib/documents/artifact-store";
import { epochNow, type EngineFeature } from "./types";

/**
 * Moteur 2 — Document Engine.
 *
 * Couche métier au-dessus du pipeline d'artefacts existant (lib/documents :
 * générateurs PDF/DOCX/XLSX/PPTX + stockage R2 + registre Firestore). Les
 * modules métier ne manipulent que des entrées simples :
 *  - `buildDocument({ title, format, markdown | blocks })` → artefact
 *    téléchargeable (artifactId) avec nom de fichier lisible ;
 *  - `blocksFromMarkdown` : conversion markdown minimaliste → blocs du plan
 *    documentaire (titres, listes, tableaux simples, paragraphes) — testée ;
 *  - `proofDocument` : preuve horodatée (audit interne) prête à archiver.
 *
 * Le contenu est TOUJOURS validé par DocumentPlanSchema via generateArtifact :
 * aucun HTML arbitraire n'est injecté dans les fichiers.
 */

export const DocumentFormatSchema = z.enum(["pdf", "docx", "xlsx", "pptx", "csv", "md", "txt", "json", "html"]);
export type DocumentFormat = z.infer<typeof DocumentFormatSchema>;

export interface BuildDocumentInput {
  userId: string;
  feature: EngineFeature;
  title: string;
  format?: DocumentFormat;
  /** Contenu en markdown simplifié (converti en blocs) — ou `blocks` direct. */
  markdown?: string;
  blocks?: Array<Record<string, unknown>>;
  description?: string;
}

export interface BuiltDocument {
  artifactId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

function sanitizeFilename(title: string): string {
  return (
    title
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9-_ ]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60)
      .toLowerCase() || "document"
  );
}

/**
 * Convertit un markdown simplifié en blocs documentaires. Supporte :
 * `# / ## / ###` titres, `- item` listes à puces, `1. item` listes ordonnées,
 * `> citation`, tableaux à barres `|`, lignes vides séparatrices, texte.
 */
export function blocksFromMarkdown(markdown: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", text: paragraph.join(" ").trim() });
      paragraph = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      blocks.push(level === 1 ? { type: "title", text: heading[2].trim() } : { type: "heading", level, text: heading[2].trim() });
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      const last = blocks[blocks.length - 1] as { type?: string; items?: string[] } | undefined;
      if (last && last.type === "list") {
        last.items = [...(last.items ?? []), bullet[1].trim()];
      } else {
        blocks.push({ type: "list", items: [bullet[1].trim()] });
      }
      continue;
    }

    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (ordered) {
      flushParagraph();
      const last = blocks[blocks.length - 1] as { type?: string; items?: string[]; ordered?: boolean } | undefined;
      if (last && last.type === "list" && last.ordered) {
        last.items = [...(last.items ?? []), ordered[1].trim()];
      } else {
        blocks.push({ type: "list", ordered: true, items: [ordered[1].trim()] });
      }
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      flushParagraph();
      blocks.push({ type: "quote", text: quote[1].trim() });
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      flushParagraph();
      const cells = trimmed.slice(1, -1).split("|").map((c) => c.trim());
      const isSeparator = cells.every((c) => /^:?-{2,}:?$/.test(c));
      if (isSeparator) continue;
      const last = blocks[blocks.length - 1] as { type?: string; rows?: string[][]; columns?: string[] } | undefined;
      if (last && last.type === "table") {
        // Rangs suivants ; le premier rang d'un tableau devient l'en-tête.
        last.rows = [...(last.rows ?? []), cells];
      } else {
        blocks.push({ type: "table", columns: cells, rows: [] });
      }
      continue;
    }

    paragraph.push(trimmed);
  }
  flushParagraph();
  return blocks.length ? blocks : [{ type: "paragraph", text: markdown.trim() }];
}

export async function buildDocument(input: BuildDocumentInput): Promise<BuiltDocument> {
  const format: DocumentFormat = input.format ?? "pdf";
  const blocks = input.blocks ?? blocksFromMarkdown(input.markdown ?? "");
  if (blocks.length === 0) throw new Error("Document vide : fournir markdown ou blocks.");

  const generated = await generateArtifact({
    userId: input.userId,
    plan: {
      title: input.title,
      format,
      ...(input.description ? { description: input.description } : {}),
      blocks,
      metadata: { feature: input.feature, generatedAt: new Date().toISOString() },
    },
  });

  const stored = await storeArtifactBuffer({
    ownerId: input.userId,
    executionId: `engine-doc-${epochNow()}`,
    name: generated.filename ?? `${sanitizeFilename(input.title)}.${format}`,
    mimeType: generated.mimeType,
    data: generated.data,
  });

  return {
    artifactId: stored.artifactId,
    filename: generated.filename ?? `${sanitizeFilename(input.title)}.${format}`,
    mimeType: generated.mimeType,
    sizeBytes: generated.data.byteLength,
  };
}

/**
 * Preuve horodatée : document d'audit listant les faits notables d'une
 * action métier (signature de contrat, décision de congé, relance…).
 */
export async function proofDocument(input: {
  userId: string;
  feature: EngineFeature;
  title: string;
  facts: Array<{ label: string; value: string }>;
  notes?: string;
}): Promise<BuiltDocument> {
  const blocks: Array<Record<string, unknown>> = [
    { type: "title", text: input.title },
    { type: "paragraph", text: `Preuve générée le ${new Date().toISOString()} (UTC) par GEN3IA — module ${input.feature}.` },
    {
      type: "table",
      columns: ["Champ", "Valeur"],
      rows: input.facts.map((fact) => [fact.label, fact.value]),
    },
  ];
  if (input.notes) blocks.push({ type: "heading", level: 2, text: "Notes" }, { type: "paragraph", text: input.notes });
  return buildDocument({ userId: input.userId, feature: input.feature, title: input.title, format: "pdf", blocks });
}
