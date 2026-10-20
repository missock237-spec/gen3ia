import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";

import type { DocumentPlan } from "../types";
import { chargerImageBloc } from "./image-embed";

type DocxHeadingLevel = (typeof HeadingLevel)[keyof typeof HeadingLevel];

function getHeadingLevel(level: number): DocxHeadingLevel {
  const levels = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ];

  return levels[Math.min(Math.max(level, 1), 6) - 1];
}

export async function generateDocx(
  plan: DocumentPlan,
): Promise<Buffer> {
  const children: Array<
    Paragraph | Table
  > = [];

  children.push(
    new Paragraph({
      text: plan.title,
      heading: HeadingLevel.TITLE,
    }),
  );

  for (const block of plan.blocks) {
    switch (block.type) {
      case "pageBreak":
        children.push(
          new Paragraph({
            pageBreakBefore: true,
          }),
        );
        break;

      case "heading":
        children.push(
          new Paragraph({
            text: block.text ?? "",
            heading: getHeadingLevel(block.level ?? 2),
          }),
        );
        break;

      case "paragraph":
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: block.text ?? "",
              }),
            ],
          }),
        );
        break;

      case "image": {
        // Audit multimodal : le bloc image était avalisé puis perdu — il est
        // désormais réellement embarqué (ImageRun). Fail-soft : note en
        // italique si la source est indisponible, le document part toujours.
        const image = await chargerImageBloc(block);
        if (image) {
          // docx exprime les dimensions en pixels (96 dpi) — largeur utile
          // A4 ≈ 600 px, ratio préservé.
          const echelle = Math.min(1, 600 / image.largeurPx);
          children.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new ImageRun({
                  data: image.buffer,
                  // docx v9 exige le type explicite (contrat IImageOptions).
                  type: image.mime === "image/png" ? "png" : "jpg",
                  transformation: {
                    width: Math.round(image.largeurPx * echelle),
                    height: Math.round(image.hauteurPx * echelle),
                  },
                }),
              ],
            }),
          );
        } else {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: "[Image indisponible : source inaccessible ou format non pris en charge]",
                  italics: true,
                  color: "888888",
                }),
              ],
            }),
          );
        }
        break;
      }

      case "quote":
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: block.text ?? "",
                italics: true,
              }),
            ],
          }),
        );
        break;

      case "code":
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: block.text ?? "",
                font: "Courier New",
              }),
            ],
          }),
        );
        break;

      case "list":
        for (const item of block.items ?? []) {
          children.push(
            new Paragraph({
              text: item,
              bullet: {
                level: 0,
              },
            }),
          );
        }
        break;

      case "table": {
        const rows = [];

        if (block.columns?.length) {
          rows.push(
            new TableRow({
              children: block.columns.map(
                (column) =>
                  new TableCell({
                    children: [
                      new Paragraph({
                        children: [
                          new TextRun({
                            text: String(column),
                            bold: true,
                          }),
                        ],
                      }),
                    ],
                  }),
              ),
            }),
          );
        }

        for (const row of block.rows ?? []) {
          rows.push(
            new TableRow({
              children: row.map(
                (value) =>
                  new TableCell({
                    children: [
                      new Paragraph({
                        text: String(value ?? ""),
                      }),
                    ],
                  }),
              ),
            }),
          );
        }

        children.push(
          new Table({
            rows,
          }),
        );

        break;
      }

      default:
        if (block.text) {
          children.push(
            new Paragraph({
              text: block.text,
            }),
          );
        }
    }
  }

  const document = new Document({
    sections: [
      {
        children,
      },
    ],
  });

  return Packer.toBuffer(document);
            }
