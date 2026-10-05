import { describe, expect, it } from "vitest";

import { generateTextArtifact } from "./text";
import { generateXlsx } from "./xlsx";
import { isDangerousCell, neutralizeCsvCell, toXlsxCellValue } from "./safe-cell";
import type { DocumentPlan } from "../types";

function csvPlan(rows: string[][]): DocumentPlan {
  return {
    title: "Export de test",
    format: "csv",
    blocks: [{ type: "table", columns: ["colonne"], rows }],
  } as DocumentPlan;
}

describe("neutralisation d'injection de formules (CSV/XLSX)", () => {
  it("isDangerousCell détecte les préfixes de formule", () => {
    for (const dangerous of ["=cmd|'/c calc'!A0", "+1+1", "-2+3", "@SUM(A1)", "\tx", "\rx"]) {
      expect(isDangerousCell(dangerous), dangerous).toBe(true);
    }
    expect(isDangerousCell("texte normal")).toBe(false);
    expect(isDangerousCell("")).toBe(false);
  });

  it("neutralizeCsvCell préfixe une apostrophe sur les cellules dangereuses", () => {
    expect(neutralizeCsvCell("=HYPERLINK(\"http://evil\",\"login\")")).toBe("'=HYPERLINK(\"http://evil\",\"login\")");
    expect(neutralizeCsvCell("normal")).toBe("normal");
  });

  it("toXlsxCellValue force le type texte pour les chaînes-formules", () => {
    const forced = toXlsxCellValue("=1+1");
    expect(forced).toEqual({ richText: [{ text: "=1+1" }] });
    expect(toXlsxCellValue("texte")).toBe("texte");
    expect(toXlsxCellValue(42)).toBe(42);
  });

  it("CSV : une cellule LLM malveillante ressort en texte, jamais en formule", () => {
    const buffer = generateTextArtifact(csvPlan([["=cmd|'/c calc'!A0"]]));
    const csv = buffer.toString("utf8");
    expect(csv).toContain("'=cmd|'/c calc'!A0");
    // La première cellule de donnée ne doit PAS commencer par « = ».
    const dataRow = csv.split("\n")[1];
    expect(dataRow?.startsWith("\"'=")).toBe(true);
  });

  it("XLSX : la cellule-formule est écrite en texte riche (pas de formule native)", async () => {
    const buffer = await generateXlsx({
      title: "Test XLSX",
      format: "xlsx",
      blocks: [{ type: "table", columns: ["a"], rows: [["=HYPERLINK(\"http://evil\",\"login\")"]] }],
    } as DocumentPlan);
    expect(buffer.length).toBeGreaterThan(0);
    // ExcelJS aurait sérialisé une formule si la cellule n'était pas forcée texte.
    const content = buffer.toString("latin1");
    expect(content).not.toContain("<f>");
  });
});
