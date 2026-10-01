/**
 * PARSER MARKDOWN PUR (Task 52) — logique de découpage des blocs extraite du
 * composant `components/workspace/markdown.tsx` : le module est feuille PURE
 * (aucune dépendance React, aucun DOM) et donc testable sous Node (vitest),
 * conformément à l'architecture des modules partagés Gen3ia.
 *
 * Support : titres (#…), listes à puces/numérotées, blocs de code, citations,
 * tableaux (`| a | b |` avec ligne de séparation) et séparateurs horizontaux
 * (---, ***, ___). Le RENDU React (sûr, sans dangerouslySetInnerHTML) reste
 * dans le composant ; ce fichier ne décide que de la STRUCTURE.
 */

export interface MarkdownBlock {
  kind: "heading" | "paragraph" | "code" | "ul" | "ol" | "quote" | "table" | "hr";
  level?: number;
  language?: string;
  lines: string[];
  /** Tableau : en-têtes et lignes déjà découpés en cellules. */
  header?: string[];
  rows?: string[][];
}

const TABLE_DELIMITER = /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/;
const HORIZONTAL_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** Découpe une ligne de tableau markdown en cellules (sans HTML). */
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { kind: "ul" | "ol"; lines: string[] } | null = null;
  let code: { language: string; lines: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", lines: paragraph });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ kind: list.kind, lines: list.lines });
      list = null;
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      if (code) {
        blocks.push({ kind: "code", language: code.language || undefined, lines: code.lines });
        code = null;
      } else {
        flushParagraph();
        flushList();
        code = { language: fence[1], lines: [] };
      }
      continue;
    }
    if (code) {
      code.lines.push(line);
      continue;
    }
    // TABLEAU : une ligne contenant « | » suivie d'une ligne de séparation
    // (|---|---|) ouvre un tableau — sinon la ligne reste un paragraphe.
    if (
      line.includes("|") &&
      index + 1 < lines.length &&
      TABLE_DELIMITER.test(lines[index + 1])
    ) {
      flushParagraph();
      flushList();
      const header = splitTableRow(line);
      const rows: string[][] = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].includes("|") && lines[cursor].trim() !== "") {
        rows.push(splitTableRow(lines[cursor]));
        cursor++;
      }
      blocks.push({ kind: "table", lines: [], header, rows });
      index = cursor - 1;
      continue;
    }
    // SÉPARATEUR horizontal (---, ***, ___) : trait de séparation entre sections.
    if (HORIZONTAL_RULE.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "hr", lines: [] });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", level: heading[1].length, lines: [heading[2]] });
      continue;
    }
    const bullet = /^\s*[-•*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (!list || list.kind !== "ul") {
        flushList();
        list = { kind: "ul", lines: [] };
      }
      list.lines.push(bullet[1]);
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (!list || list.kind !== "ol") {
        flushList();
        list = { kind: "ol", lines: [] };
      }
      list.lines.push(ordered[1]);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "quote", lines: [quote[1]] });
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    paragraph.push(line);
  }
  if (code) blocks.push({ kind: "code", language: code.language || undefined, lines: code.lines });
  flushParagraph();
  flushList();
  return blocks;
}
