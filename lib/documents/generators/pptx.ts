import pptxgen from "pptxgenjs";
import type { DocumentPlan } from "../types";

/**
 * AI SLIDES — modèles professionnels appliqués automatiquement.
 *
 * Trois gabarits déterministes, choisis d'après le TITRE du livrable (aucune
 * dépendance à un LLM) : « aurora » (premium sombre à dégradés violets),
 * « corporate » (clair bleu entreprise) et « edu » (clair chaleureux).
 * Chaque modèle habille : page de titre (bandeau + accent), titres de
 * sections (barre d'accent), texte/listes/tableaux, pied de page numéroté.
 */

export type PptxTemplateId = "aurora" | "corporate" | "edu";

interface PptxTemplate {
  id: PptxTemplateId;
  /** Fond de la page de titre (couleur pleine) ou undefined = fond clair. */
  coverBackground: string | undefined;
  background: string | undefined;
  titleColor: string;
  textColor: string;
  accent: string;
  accentAlt: string;
  footerColor: string;
  tableHeaderFill: string;
  tableHeaderColor: string;
  tableBorder: string;
}

const TEMPLATES: Record<PptxTemplateId, PptxTemplate> = {
  aurora: {
    id: "aurora",
    coverBackground: "0B0C1B",
    background: "11132B",
    titleColor: "FFFFFF",
    textColor: "D9DCF5",
    accent: "7C5CFF",
    accentAlt: "E14FEA",
    footerColor: "8B90B7",
    tableHeaderFill: "7C5CFF",
    tableHeaderColor: "FFFFFF",
    tableBorder: "3A3D63",
  },
  corporate: {
    id: "corporate",
    coverBackground: undefined,
    background: undefined,
    titleColor: "0F2A4A",
    textColor: "27364B",
    accent: "1B6DE0",
    accentAlt: "0F2A4A",
    footerColor: "8A97A8",
    tableHeaderFill: "1B6DE0",
    tableHeaderColor: "FFFFFF",
    tableBorder: "C9D6E6",
  },
  edu: {
    id: "edu",
    coverBackground: undefined,
    background: undefined,
    titleColor: "4A2E14",
    textColor: "3B3327",
    accent: "D97E29",
    accentAlt: "2E7D5B",
    footerColor: "A08A70",
    tableHeaderFill: "D97E29",
    tableHeaderColor: "FFFFFF",
    tableBorder: "E2D4C0",
  },
};

/** Choix déterministe du modèle d'après le titre énoncé par l'utilisateur. */
export function pickPptxTemplate(title: string): PptxTemplateId {
  const lower = (title ?? "").toLowerCase();
  if (/\b(?:finance|financier|bilan|r[ée]sultats?|investisseurs?|corporate|entreprise|commercial|ventes?|kpi|r[ée]union|projet)\b/.test(lower)) return "corporate";
  if (/\b(?:formation|[ée]ducation|cours|p[ée]dagog|atelier|s[ée]minaire|[ée]cole|[ée]tudiant|tutorial|guide)\b/.test(lower)) return "edu";
  return "aurora";
}

export async function generatePptx(
  plan: DocumentPlan,
): Promise<Buffer> {
  const template = TEMPLATES[pickPptxTemplate(plan.title)];
  const pptx = new pptxgen();

  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Gen3ia AI Studio";
  pptx.subject = plan.title;
  pptx.title = plan.title;
  pptx.company = "Gen3ia";

  let slideNumber = 0;
  const addSlide = (isCover: boolean) => {
    slideNumber += 1;
    const slide = pptx.addSlide();
    if (isCover && template.coverBackground) {
      slide.background = { color: template.coverBackground };
    } else if (template.background) {
      slide.background = { color: template.background };
    }
    // Bande d'accent signature en bas de chaque page.
    slide.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 7.18,
      w: "100%",
      h: 0.08,
      fill: { type: "solid", color: template.accent },
      line: { color: template.accent, width: 0 },
    });
    slide.addText(`${slideNumber} · Gen3ia`, {
      x: 11.4,
      y: 6.85,
      w: 1.4,
      h: 0.3,
      fontSize: 8,
      color: template.footerColor,
      align: "right",
    });
    return slide;
  };

  // Page de titre premium : accent vertical + titre + filet dégradé simulé.
  let slide = addSlide(true);
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.7,
    y: 2.55,
    w: 0.09,
    h: 1.5,
    fill: { type: "solid", color: template.accent },
    line: { color: template.accent, width: 0 },
  });
  slide.addText(plan.title, {
    x: 1.0,
    y: 2.55,
    w: 11.4,
    h: 1.0,
    fontSize: 32,
    bold: true,
    color: template.titleColor,
    fit: "shrink",
  });
  slide.addText("Gen3ia AI Studio", {
    x: 1.0,
    y: 3.62,
    w: 6,
    h: 0.4,
    fontSize: 13,
    color: template.accentAlt === template.accent ? template.accent : template.accentAlt,
  });

  let y = 0.7;

  const newSlide = () => {
    slide = addSlide(false);
    y = 0.7;
  };

  for (const block of plan.blocks) {
    switch (block.type) {
      case "pageBreak":
        newSlide();
        break;

      case "heading":
        if (y > 6) {
          newSlide();
        }

        // Barre d'accent à gauche du titre de section.
        slide.addShape(pptx.ShapeType.rect, {
          x: 0.7,
          y: y + 0.04,
          w: 0.07,
          h: 0.42,
          fill: { type: "solid", color: template.accent },
          line: { color: template.accent, width: 0 },
        });
        slide.addText(block.text ?? "", {
          x: 0.92,
          y,
          w: 11.4,
          h: 0.5,
          fontSize: block.level === 1 ? 24 : 19,
          bold: true,
          color: template.titleColor,
          fit: "shrink",
        });

        y += 0.75;
        break;

      case "paragraph":
      case "quote":
      case "code":
        if (y > 5.8) {
          newSlide();
        }

        slide.addText(block.text ?? "", {
          x: 0.9,
          y,
          w: 11.2,
          h: 1.2,
          fontSize: block.type === "code" ? 11 : 14,
          italic: block.type === "quote",
          color: template.textColor,
          fit: "shrink",
          breakLine: false,
        });

        y += 1.35;
        break;

      case "list": {
        if (y > 5.3) {
          newSlide();
        }

        const text = (block.items ?? [])
          .map((item, index) =>
            block.ordered
              ? `${index + 1}. ${item}`
              : `• ${item}`,
          )
          .join("\n");

        slide.addText(text, {
          x: 1,
          y,
          w: 10.8,
          h: 2,
          fontSize: 14,
          color: template.textColor,
          fit: "shrink",
        });

        y += 2.1;
        break;
      }

      case "table": {
        if (y > 4.8) {
          newSlide();
        }

        const rows = [
          ...(block.columns
            ? [block.columns]
            : []),
          ...(block.rows ?? []),
        ];

        if (rows.length > 0) {
          const tableRows = rows.map(
            (row, rowIndex) =>
              row.map(
                (cell) => ({
                  text: cell,
                  options:
                    rowIndex === 0
                      ? { bold: true, color: template.tableHeaderColor, fill: { type: "solid" as const, color: template.tableHeaderFill } }
                      : { color: template.textColor },
                }),
              ),
          );

          slide.addTable(tableRows, {
            x: 0.7,
            y,
            w: 12,
            h: 2.5,
            fontSize: 10,
            border: {
              type: "solid",
              pt: 1,
              color: template.tableBorder,
            },
          });

          y += 2.8;
        }

        break;
      }
    }
  }

  const output = await pptx.write({
    outputType: "nodebuffer",
  });

  return Buffer.from(output as Buffer);
}
