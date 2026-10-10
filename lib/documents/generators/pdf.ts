import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import type { DocumentPlan } from "../types";

/**
 * Normalisation WinAnsi (Task 114) : les polices standard PDF (Helvetica)
 * encodent en CP1252 — un caractère hors jeu (trait d'union insécable
 * U+2011, emoji, guillemet exotique…) fait échouer TOUTE la génération
 * (« WinAnsi cannot encode »). Chaque caractère non encodable est remplacé
 * par son équivalent lisible, au pire « ? » : le document part TOUJOURS.
 */
const CP1252_RE = /[\x00-\x7F\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178\u00A0-\u00FF\n\t\r]/;
const PDF_CHAR_FALLBACK: Record<string, string> = {
  "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2212": "-",
  "\u2015": "\u2014", "\u2032": "'", "\u2033": '"',
  "\u00AB": '"', "\u00BB": '"', "\u2E3A": "--", "\u2E3B": "---",
  "\u2043": "\u2022", "\u00A0": " ", "\u202F": " ", "\u2009": " ", "\u200B": "",
};

function textePdfSafe(input: unknown): string {
  const source = typeof input === "string" ? input : String(input ?? "");
  let out = "";
  for (const ch of source) {
    if (CP1252_RE.test(ch)) {
      out += ch;
      continue;
    }
    out += PDF_CHAR_FALLBACK[ch] ?? "?";
  }
  return out;
}

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 50;

export async function generatePdf(plan: DocumentPlan): Promise<Buffer> {
  const pdf = await PDFDocument.create();

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);

  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const newPage = () => {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  };

  const ensureSpace = (height: number) => {
    if (y - height < MARGIN) {
      newPage();
    }
  };

  const wrapText = (
    text: string,
    font: PDFFont,
    size: number,
    maxWidth: number,
  ): string[] => {
    const words = text.replace(/\r/g, "").split(/\s+/);
    const result: string[] = [];
    let current = "";

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;

      if (
        font.widthOfTextAtSize(candidate, size) > maxWidth &&
        current
      ) {
        result.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }

    if (current) {
      result.push(current);
    }

    return result;
  };

  const drawParagraph = (
    text: string,
    options: {
      font?: PDFFont;
      size?: number;
      indent?: number;
      spacing?: number;
    } = {},
  ) => {
    const font = options.font ?? regular;
    const size = options.size ?? 11;
    const indent = options.indent ?? 0;
    const spacing = options.spacing ?? 5;

    const lines = text.split("\n");

    for (const rawLine of lines) {
      if (!rawLine.trim()) {
        y -= size + spacing;
        continue;
      }

      const wrapped = wrapText(
        rawLine,
        font,
        size,
        PAGE_WIDTH - MARGIN * 2 - indent,
      );

      for (const line of wrapped) {
        ensureSpace(size + spacing);

        page.drawText(textePdfSafe(line), {
          x: MARGIN + indent,
          y,
          size,
          font,
          color: rgb(0.08, 0.08, 0.1),
        });

        y -= size + spacing;
      }
    }

    y -= 5;
  };

  const drawHeading = (text: string, level: number) => {
    const size = level <= 1 ? 18 : level === 2 ? 15 : 13;

    ensureSpace(size + 20);

    page.drawText(textePdfSafe(text), {
      x: MARGIN,
      y,
      size,
      font: bold,
      color: rgb(0.04, 0.04, 0.08),
    });

    y -= size + 12;
  };

  page.drawText(textePdfSafe(plan.title), {
    x: MARGIN,
    y,
    size: 22,
    font: bold,
    color: rgb(0.05, 0.05, 0.1),
  });

  y -= 35;

  for (const block of plan.blocks) {
    switch (block.type) {
      case "pageBreak":
        newPage();
        break;

      case "title":
        break;

      case "heading":
        drawHeading(block.text ?? "", block.level ?? 2);
        break;

      case "paragraph":
        drawParagraph(block.text ?? "");
        break;

      case "quote":
        drawParagraph(`"${block.text ?? ""}"`, {
          font: italic,
          indent: 15,
        });
        break;

      case "code":
        drawParagraph(block.text ?? "", {
          size: 9,
          indent: 10,
          spacing: 3,
        });
        break;

      case "list":
        for (const [index, item] of (block.items ?? []).entries()) {
          const prefix = block.ordered
            ? `${index + 1}.`
            : "•";

          drawParagraph(`${prefix} ${item}`, {
            indent: 10,
          });
        }
        break;

      case "table": {
        const columns = block.columns ?? [];
        const rows = block.rows ?? [];

        const columnCount = Math.max(
          columns.length,
          ...rows.map((r) => r.length),
        );

        if (columnCount === 0) break;

        const columnWidth =
          (PAGE_WIDTH - MARGIN * 2) / columnCount;

        const allRows = [
          columns,
          ...rows,
        ];

        for (const row of allRows) {
          ensureSpace(25);

          const height = 22;

          row.forEach((value, index) => {
            page.drawRectangle({
              x: MARGIN + index * columnWidth,
              y: y - height + 4,
              width: columnWidth,
              height,
              borderColor: rgb(0.7, 0.7, 0.7),
              borderWidth: 0.5,
            });

            page.drawText(textePdfSafe(String(value ?? "")), {
              x: MARGIN + index * columnWidth + 5,
              y: y - 13,
              size: 8,
              font: index === 0 && row === columns ? bold : regular,
            });
          });

          y -= height;
        }

        y -= 10;
        break;
      }

      default:
        if (block.text) {
          drawParagraph(block.text);
        }
    }
  }

  return Buffer.from(await pdf.save());
}
