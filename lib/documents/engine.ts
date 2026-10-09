import {
  DocumentRequest,
  GeneratedDocument
} from "./types";

import {
  randomUUID,
} from "node:crypto";

import path from "node:path";

import {
  DocumentPlanSchema,
  sanitizeDocumentPlan,
} from "./types";

import {
  EXTENSIONS,
} from "./mime";

import {
  generateDocument,
} from "./generators";

import {
  validateArtifact,
} from "./validator";

import type {
  ZipEntry,
} from "./zip";

export interface GenerateArtifactInput {
  userId: string;

  plan: unknown;

  projectId?: string;

  executionId?: string;

  zipEntries?: ZipEntry[];
}

export async function generateArtifact(
  input: GenerateArtifactInput,
) {
  // SANITIZER (Task 114) : un écart de format du LLM (type de bloc inventé,
  // URL malformée) ne fait JAMAIS échouer la génération — coercition d'abord.
  const plan =
    DocumentPlanSchema.parse(sanitizeDocumentPlan(input.plan));

  let data: Buffer;

  if (plan.format === "zip") {
    // archiver chargé UNIQUEMENT à la demande (audit 2-a, C3 : cold start
    // serverless — échec d'import re-levé avec un message explicite).
    let zip: typeof import("./zip");
    try {
      zip = await import("./zip");
    } catch (error) {
      throw new Error(
        `Module « zip » indisponible : ${error instanceof Error ? error.message : String(error)}`
      );
    }

    data = await zip.createZip(
      input.zipEntries ?? [],
    );
  } else {
    data = await generateDocument(plan);
  }

  const validation =
    validateArtifact(
      plan.format,
      data,
    );

  if (!validation.valid) {
    throw new Error(
      `Artifact validation failed: ${validation.errors.join(
        "; ",
      )}`,
    );
  }

  const artifactId = randomUUID();

  const safeTitle =
    plan.title
      .replace(
        /[^a-zA-Z0-9._-]+/g,
        "-",
      )
      .replace(/-+/g, "-")
      .slice(0, 80) ||
    "artifact";

  const filename =
    `${safeTitle}.${EXTENSIONS[plan.format]}`;

  const storagePath =
    path.posix.join(
      "users",
      input.userId,
      "artifacts",
      artifactId,
      filename,
    );

  return {
    artifactId,

    userId: input.userId,

    projectId: input.projectId,

    executionId: input.executionId,

    filename,

    format: plan.format,

    mimeType: validation.mimeType,

    sizeBytes: data.length,

    storagePath,

    data,

    validation,

    createdAt:
      new Date().toISOString(),
  };
}

export class DocumentEngine {
  async generate(
    request: DocumentRequest
  ): Promise<GeneratedDocument> {
    switch (request.format) {
      case "docx":
        return this.generateDocx(request);

      case "pdf":
        return this.generatePdf(request);

      case "txt":
        return this.generateText(request);

      case "md":
        return this.generateText(request);

      default:
        throw new Error(
          `Unsupported document format: ${request.format}`
        );
    }
  }

  private async generateDocx(
    request: DocumentRequest
  ): Promise<GeneratedDocument> {
    // docx (~1 Mo) chargé UNIQUEMENT à la demande (audit 2-a, C3 : cold
    // start serverless — échec d'import re-levé avec un message explicite).
    let docx: typeof import("docx");
    try {
      docx = await import("docx");
    } catch (error) {
      throw new Error(
        `Module « docx » indisponible : ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const { Document, Packer, Paragraph, TextRun } = docx;

    const paragraphs =
      request.content
        .split(/\n+/)
        .map(
          (text) =>
            new Paragraph({
              children: [
                new TextRun({
                  text
                })
              ]
            })
        );

    const document =
      new Document({
        sections: [
          {
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: request.title,
                    bold: true,
                    size: 32
                  })
                ]
              }),
              ...paragraphs
            ]
          }
        ]
      });

    const buffer =
      await Packer.toBuffer(document);

    return {
      filename:
        `${this.safeFilename(request.title)}.docx`,
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer,
      size: buffer.length
    };
  }

  private async generatePdf(
    request: DocumentRequest
  ): Promise<GeneratedDocument> {
    // pdf-lib chargé UNIQUEMENT à la demande (audit 2-a, C3 : cold start
    // serverless — échec d'import re-levé avec un message explicite).
    let pdfLib: typeof import("pdf-lib");
    try {
      pdfLib = await import("pdf-lib");
    } catch (error) {
      throw new Error(
        `Module « pdf-lib » indisponible : ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const { PDFDocument, StandardFonts, rgb } = pdfLib;

    const pdf =
      await PDFDocument.create();

    const page =
      pdf.addPage();

    const font =
      await pdf.embedFont(
        StandardFonts.Helvetica
      );

    page.drawText(
      request.title,
      {
        x: 50,
        y: 750,
        size: 20,
        font,
        color: rgb(0, 0, 0)
      }
    );

    const lines =
      request.content.split(/\n+/);

    let y = 720;

    for (const line of lines) {
      if (y < 50) {
        y = 750;
        pdf.addPage();
      }

      const currentPage =
        pdf.getPages().at(-1)!;

      currentPage.drawText(
        line.slice(0, 110),
        {
          x: 50,
          y,
          size: 10,
          font
        }
      );

      y -= 16;
    }

    const bytes =
      await pdf.save();

    const buffer =
      Buffer.from(bytes);

    return {
      filename:
        `${this.safeFilename(request.title)}.pdf`,
      mimeType: "application/pdf",
      buffer,
      size: buffer.length
    };
  }

  private async generateText(
    request: DocumentRequest
  ): Promise<GeneratedDocument> {
    const buffer =
      Buffer.from(
        `${request.title}\n\n${request.content}`,
        "utf8"
      );

    return {
      filename:
        `${this.safeFilename(request.title)}.${request.format}`,
      mimeType:
        request.format === "md"
          ? "text/markdown"
          : "text/plain",
      buffer,
      size: buffer.length
    };
  }

  private safeFilename(
    filename: string
  ): string {
    return filename
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase();
  }
  }
