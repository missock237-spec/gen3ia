import type { DocumentPlan } from "../types";
import { generateTextArtifact } from "./text";
import { generatePdf } from "./pdf";
import { generateDocx } from "./docx";
import { generateXlsx } from "./xlsx";
import { generatePptx } from "./pptx";

export async function generateDocument(
  plan: DocumentPlan,
): Promise<Buffer> {
  switch (plan.format) {
    case "txt":
    case "md":
    case "csv":
    case "json":
    case "html":
      return generateTextArtifact(plan);

    case "pdf":
      return generatePdf(plan);

    case "docx":
      return generateDocx(plan);

    case "xlsx":
      return generateXlsx(plan);

    case "pptx":
      return generatePptx(plan);

    case "zip":
      throw new Error(
        "ZIP must be created through the ZIP engine.",
      );

    default:
      throw new Error(`Unsupported document format: ${(plan as { format: string }).format}`);
  }
}
