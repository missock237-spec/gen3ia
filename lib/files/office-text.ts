/**
 * Extraction de texte des formats bureautiques ZIP-based et RTF.
 *
 * Rend possible l'ANALYSE RÉELLE par Gen3ia des documents bureautiques
 * « libres » acceptés par la politique de téléversement : ODT/ODS/ODP
 * (OpenDocument = zip de XML), PPTX (zip de slides XML), EPUB (zip de
 * XHTML) et RTF (texte balisé). Historiquement ces formats tombaient dans
 * le fallback « binaire → métadonnées seules » : le fichier était accepté
 * mais jamais analysable — exactement la situation interdite par la
 * mission (« tout fichier importé doit pouvoir être analysé »).
 *
 * Technique : même brique que docxToText (yauzl + markupToText) — machine à
 * états anti-injection, aucune regex de stripping fragile sur le XML/HTML.
 */

import yauzl from "yauzl";

import { markupToText } from "@/lib/content/html-text";

/** Garde-fou cumulé (octets décompressés) — aligné sur KNOWLEDGE_MAX_TEXT_BYTES. */
const MAX_TOTAL_BYTES = 2_000_000;
/** Garde-fou par entrée de l'archive. */
const MAX_ENTRY_BYTES = 2_000_000;

type ZipEntry = { path: string; content: string };

/**
 * Lit un buffer ZIP et renvoie les entrées dont le chemin satisfait le
 * prédicat, décompressées et décodées UTF-8. Robuste : garde-fous de taille,
 * fermeture garantie, erreur explicite si l'archive est invalide.
 */
export async function readZipEntries(
  buffer: Buffer,
  predicate: (path: string) => boolean,
  label = "archive",
): Promise<ZipEntry[]> {
  return new Promise<ZipEntry[]>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        // Erreur yauzl enveloppée : message clair et uniforme pour l'utilisateur
        // (l'original « End of central directory record signature not found »
        // n'est pas actionnable).
        reject(new Error(`${label} illisible (archive zip invalide ou corrompue).`, { cause: error }));
        return;
      }
      let settled = false;
      let total = 0;
      const entries: ZipEntry[] = [];
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        try { zipFile.close(); } catch { /* déjà fermé */ }
        fn();
      };

      zipFile.on("error", () => finish(() => reject(new Error(`${label} illisible : archive corrompue.`))));
      zipFile.on("end", () => finish(() => resolve(entries)));
      zipFile.on("entry", (entry: yauzl.Entry) => {
        if (!predicate(entry.fileName) || entry.uncompressedSize > MAX_ENTRY_BYTES) {
          zipFile.readEntry();
          return;
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            zipFile.readEntry();
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_TOTAL_BYTES) {
              finish(() => reject(new Error(`${label} trop volumineux (texte extrait > 2 Mo).`)));
              stream.destroy();
              return;
            }
            chunks.push(chunk);
          });
          stream.on("end", () => {
            entries.push({ path: entry.fileName, content: Buffer.concat(chunks).toString("utf8") });
            zipFile.readEntry();
          });
          stream.on("error", () => zipFile.readEntry());
        });
      });
      zipFile.readEntry();
    });
  });
}

/** ODT/ODP (OpenDocument texte/présentation) : content.xml → texte par paragraphes. */
export async function opendocumentToText(buffer: Buffer): Promise<string> {
  const entries = await readZipEntries(buffer, (p) => p === "content.xml", "OpenDocument");
  const content = entries[0]?.content;
  if (!content) throw new Error("OpenDocument sans contenu texte (content.xml absent).");
  return markupToText(content, {
    blockElements: ["text:p", "text:h", "table:table-row"],
    tabElements: ["text:tab"],
    collapseWhitespace: false,
  })
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/**
 * ODS (classeur OpenDocument) : content.xml → lignes CSV lisibles (une ligne
 * par ligne de tableau, cellules entre guillemets) — le modèle peut ensuite
 * raisonner dessus comme sur un CSV importé.
 */
export async function odsToText(buffer: Buffer): Promise<string> {
  const entries = await readZipEntries(buffer, (p) => p === "content.xml", "Classeur OpenDocument");
  const xml = entries[0]?.content ?? "";
  if (!xml) throw new Error("Classeur OpenDocument sans contenu (content.xml absent).");

  // Extraction pragmatique des tableaux : cellules traitées en blocs, puis
  // assemblage CSV d'une ligne par table:table-row.
  const rows: string[] = [];
  const rowRegex = /<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g;
  let match: RegExpExecArray | null;
  while ((match = rowRegex.exec(xml)) !== null) {
    const cells: string[] = [];
    const cellRegex = /<table:table-cell[^>]*>([\s\S]*?)<\/table:table-cell>|<table:table-cell[^>]*\/>/g;
    let cell: RegExpExecArray | null;
    while ((cell = cellRegex.exec(match[1])) !== null) {
      const texte = markupToText(cell[1] ?? "", { collapseWhitespace: true }).trim();
      cells.push(`"${texte.replaceAll('"', '""')}"`);
    }
    if (cells.some((c) => c !== '""')) rows.push(cells.join(","));
  }
  if (rows.length === 0) {
    // Pas de tableau : retomber sur le texte général (présentation, notes).
    return opendocumentToText(buffer);
  }
  return rows.slice(0, 50_000).join("\n");
}

/** PPTX : ppt/slides/slideN.xml triés NUMÉRIQUEMENT → texte des diapositives. */
export async function pptxToText(buffer: Buffer): Promise<string> {
  const entries = await readZipEntries(
    buffer,
    (p) => /^ppt\/slides\/slide\d+\.xml$/.test(p),
    "Présentation PowerPoint",
  );
  if (entries.length === 0) throw new Error("Présentation sans diapositives (ppt/slides absent).");
  entries.sort((a, b) => {
    const n = (path: string) => Number(path.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
    return n(a.path) - n(b.path);
  });
  const parties = entries.map((entry, index) => {
    const texte = markupToText(entry.content, {
      blockElements: ["a:p", "a:br"],
      tabElements: ["a:tab"],
      collapseWhitespace: false,
    })
      .replace(/[ \t]+/g, " ")
      .trim();
    return `— Diapositive ${index + 1} —\n${texte}`;
  });
  return parties.filter((p) => p.replace(/—[\s\S]*?—/, "").trim().length > 0).join("\n\n");
}

/** EPUB : entrées XHTML/HTML triées par chemin → texte (approximation du spine). */
export async function epubToText(buffer: Buffer): Promise<string> {
  const entries = await readZipEntries(
    buffer,
    (p) => /\.(xhtml|html|htm)$/i.test(p) && !/^(cover|toc|nav)\./i.test(p.split("/").pop() ?? ""),
    "Livre EPUB",
  );
  if (entries.length === 0) throw new Error("EPUB sans contenu HTML lisible.");
  entries.sort((a, b) => a.path.localeCompare(b.path, "fr", { numeric: true }));
  const parties = entries
    .map((entry) => markupToText(entry.content).replace(/\n{3,}/g, "\n\n").trim())
    .filter((t) => t.length > 0);
  return parties.join("\n\n");
}

/**
 * RTF → texte : traitement des groupes ignorés ({\*\…} destinations), des
 * commandes de mise en forme, \par/\line → retours ligne, \uNNNN? →
 * caractère Unicode, échappements \{ \} \\. Suffisant pour l'analyse du
 * contenu des RTF courants (Word, LibreOffice, TextEdit).
 */
export function rtfToText(rtf: string): string {
  if (!rtf.startsWith("{\\rtf")) return rtf;
  let out = "";
  let index = 0;
  const n = rtf.length;
  let profondeur = 0;
  const ignorés: number[] = []; // profondeurs des groupes {\* …} à ignorer

  while (index < n) {
    const ch = rtf[index];
    if (ch === "{") {
      profondeur += 1;
      // Destination ignorée : groupe {\*\cmd …} (historique, champ, etc.).
      if (rtf.startsWith("\\*", index + 1)) ignorés.push(profondeur);
      index += 1;
      continue;
    }
    if (ch === "}") {
      if (ignorés[ignorés.length - 1] === profondeur) ignorés.pop();
      profondeur -= 1;
      index += 1;
      continue;
    }
    if (ignorés.length > 0) { index += 1; continue; }
    if (ch === "\\") {
      const suit = rtf.slice(index + 1);
      // Commandes : \cmd[NNN][ ] — les chiffres sont OPTIONNELS (\ansi,
      // \par, \line n'en ont pas) ; l'espace final est un délimiteur à
      // consommer uniquement s'il existe.
      const cmd = /^([a-z]+)(-?\d+)? ?/.exec(suit);
      if (cmd) {
        const [, nom, valeur] = cmd;
        if (nom === "par" || nom === "line") out += "\n";
        else if (nom === "tab") out += "\t";
        else if (nom === "u" && valeur !== undefined) {
          const code = Number(valeur);
          const réel = code < 0 ? code + 65_536 : code;
          out += String.fromCodePoint(réel);
          // Spécification RTF : UN caractère de substitution suit \uN
          // (souvent « ? ») — il est ignoré. Avancement : backslash + match
          // + substitut.
          index += 1 + cmd[0].length + 1;
          continue;
        }
        // Avancement : backslash courant + la longueur du match (dans suit).
        index += 1 + cmd[0].length;
        continue;
      }
      // Symbole échappé : \{ \} \\ \| \~ \_ \- (suit SANS le backslash).
      const symbole = /^([{}\\|~_-])/.exec(suit);
      if (symbole) {
        out += symbole[1] === "~" ? " " : symbole[1];
        index += 2;
        continue;
      }
      // Hexadécimal : \'hh → caractère.
      const hex = /^'([0-9a-fA-F]{2})/.exec(suit);
      if (hex) {
        out += String.fromCharCode(Number.parseInt(hex[1], 16));
        index += 4;
        continue;
      }
      index += 2;
      continue;
    }
    if (ch === "\n" || ch === "\r") { index += 1; continue; }
    out += ch;
    index += 1;
  }
  // Espaces multiples (groupes ignorés, commandes) réduits : le texte est
  // destiné à l'analyse, pas au rendu fidèle.
  return out.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}
