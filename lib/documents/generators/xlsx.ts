import ExcelJS from "exceljs";
import type { DocumentPlan } from "../types";
import { toXlsxCellValue } from "./safe-cell";

export async function generateXlsx(
  plan: DocumentPlan,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  workbook.creator = "Gen3ia AI Studio";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(
    plan.title.slice(0, 31) || "Sheet1",
  );

  sheet.addRow([plan.title]);
  sheet.addRow([]);

  for (const block of plan.blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
        sheet.addRow([toXlsxCellValue(block.text ?? "")]);
        break;

      case "list":
        for (const item of block.items ?? []) {
          sheet.addRow([toXlsxCellValue(item)]);
        }
        break;

      case "table": {
        if (block.columns?.length) {
          const header = sheet.addRow(block.columns.map(toXlsxCellValue));

          header.font = {
            bold: true,
          };
        }

        for (const row of block.rows ?? []) {
          sheet.addRow(row.map(toXlsxCellValue));
        }

        break;
      }

      case "code":
        sheet.addRow([toXlsxCellValue(block.text ?? "")]);
        break;

      case "quote":
        sheet.addRow([toXlsxCellValue(block.text ?? "")]);
        break;
    }
  }

  for (const column of sheet.columns) {
    let maxLength = 10;

    column.eachCell?.({ includeEmpty: false }, (cell) => {
      const value = cell.value;
      // Cellules texte forcé (richText) : largeur sur la longueur réelle.
      const length =
        typeof value === "object" && value !== null && "richText" in value
          ? (value as { richText: Array<{ text: string }> }).richText.reduce((sum, run) => sum + run.text.length, 0)
          : String(value ?? "").length;
      maxLength = Math.max(maxLength, length);
    });

    column.width = Math.min(maxLength + 2, 60);
  }

  const output = await workbook.xlsx.writeBuffer();

  return Buffer.from(output);
}
