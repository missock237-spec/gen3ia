/**
 * Extraction texte d'un PDF natif — module PUR partagé.
 *
 * Emplacement dédié (hors lib/files/import.ts et lib/knowledge/ingestion.ts)
 * pour éviter tout cycle d'imports : l'import de conversation ET l'ingestion
 * Knowledge consomment la même extraction (exigence production : le PDF est
 * accepté partout où un fichier est accepté).
 */

import { inflateSync, inflateRawSync } from "zlib";

export function pdfToText(buffer: Buffer): { text: string; pageCount: number } {
  const raw = buffer.toString("latin1");
  const pageCount = Math.max((raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length, 0);
  const chunks: string[] = [];
  const streamRe = /stream\r?\n?([\s\S]*?)endstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(raw)) !== null) {
    const streamBody = Buffer.from(match[1], "latin1");
    let content: string | null = null;
    try {
      content = inflateSync(streamBody).toString("latin1");
    } catch {
      try {
        content = inflateRawSync(streamBody).toString("latin1");
      } catch {
        content = match[1]; // stream non compressé : opérateurs lisibles directs
      }
    }
    if (!content || !/(Tj|TJ)/.test(content)) continue;
    const textParts: string[] = [];
    const tokenRe = /\((?:\\.|[^\\)])*\)|TJ|Tj|T\*|Td|TD|ET|BT|<([0-9A-Fa-f\s]+)>/g;
    let token: RegExpExecArray | null;
    while ((token = tokenRe.exec(content)) !== null) {
      if (token[0] === "T*" || token[0] === "Td" || token[0] === "TD" || token[0] === "ET") {
        textParts.push("\n");
      } else if (token[1] !== undefined) {
        // Chaîne hexadécimale (UTF-16BE fréquent dans les PDF générés)
        const hex = token[1].replace(/\s+/g, "");
        let decoded = "";
        for (let i = 0; i + 3 < hex.length + 1; i += 4) {
          const code = Number.parseInt(hex.slice(i, i + 4), 16);
          if (!Number.isNaN(code) && code >= 32) decoded += String.fromCharCode(code);
        }
        if (decoded) textParts.push(decoded);
      } else {
        const literal = token[0].slice(1, -1)
          .replace(/\\([nrtbf()\\])/g, (_, escaped: string) =>
            ({ n: "\n", r: "\n", t: "\t", b: "", f: "" })[escaped] ?? escaped)
          .replace(/\\[0-7]{1,3}/g, (oct) => String.fromCharCode(Number.parseInt(oct.slice(1), 8)));
        if (literal) textParts.push(literal);
      }
    }
    const extracted = textParts.join("").trim();
    if (extracted.length > 20) chunks.push(extracted);
  }

  const text = chunks
    .join("\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, pageCount };
}
