import type { DocumentPlan } from "../types";
import { generateTextArtifact } from "./text";

/**
 * Chargement dynamique d'un générateur lourd (audit perf 2-a, lot C3) :
 * pdf-lib, docx, exceljs et pptxgenjs (~3-4 Mo parsés) ne sont chargés que
 * par le format réellement demandé — les routes /api/files, /api/documents
 * et les outils agent démarrent sans les parser (cold start serverless).
 * L'échec d'import (bundle incomplet, déploiement partiel) est re-levé avec
 * un message explicite plutôt qu'une MODULE_NOT_FOUND brute.
 */
async function loadGenerator<T>(
  format: string,
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    throw new Error(
      `Module de génération « ${format} » indisponible : ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

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

    case "pdf": {
      const { generatePdf } = await loadGenerator("pdf", () => import("./pdf"));
      return generatePdf(plan);
    }

    case "docx": {
      const { generateDocx } = await loadGenerator("docx", () => import("./docx"));
      return generateDocx(plan);
    }

    case "xlsx": {
      const { generateXlsx } = await loadGenerator("xlsx", () => import("./xlsx"));
      return generateXlsx(plan);
    }

    case "pptx": {
      const { generatePptx } = await loadGenerator("pptx", () => import("./pptx"));
      return generatePptx(plan);
    }

    case "zip":
      throw new Error(
        "ZIP must be created through the ZIP engine.",
      );

    default:
      throw new Error(`Unsupported document format: ${(plan as { format: string }).format}`);
  }
}
