import { describe, expect, it } from "vitest";

import {
  epubToText,
  odsToText,
  opendocumentToText,
  pptxToText,
  readZipEntries,
  rtfToText,
} from "./office-text";

/* ------------------------------------------------------------------ */
/* Helper : fabrique un ZIP « stored » minimal (zéro dépendance)       */
/* ------------------------------------------------------------------ */

const TABLE_CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const octet of data) crc = TABLE_CRC[(crc ^ octet) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Construit un ZIP valide (méthode stored) à partir de paires [chemin, contenu]. */
function zipMinimal(entries: Array<[string, string]>): Buffer {
  const morceaux: Buffer[] = [];
  const centraux: Buffer[] = [];
  let offset = 0;

  for (const [path, content] of entries) {
    const nom = Buffer.from(path, "utf8");
    const data = Buffer.from(content, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version nécessaire
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // méthode : stored
    local.writeUInt16LE(0, 10); // heure
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nom.length, 26);
    local.writeUInt16LE(0, 28);
    morceaux.push(local, nom, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nom.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centraux.push(central, nom);

    offset += 30 + nom.length + data.length;
  }

  const tailleCentrale = centraux.reduce((t, b) => t + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(tailleCentrale, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...morceaux, ...centraux, eocd]);
}

/* ------------------------------------------------------------------ */
/* readZipEntries                                                      */
/* ------------------------------------------------------------------ */

describe("readZipEntries — extraction zip réelle", () => {
  it("renvoie uniquement les entrées qui satisfont le prédicat", async () => {
    const zip = zipMinimal([
      ["word/document.xml", "<w:p>un</w:p>"],
      ["ppt/slides/slide1.xml", "<a:p>diapo</a:p>"],
    ]);
    const entrées = await readZipEntries(zip, (p) => p === "word/document.xml", "test");
    expect(entrées).toHaveLength(1);
    expect(entrées[0].path).toBe("word/document.xml");
    expect(entrées[0].content).toContain("un");
  });

  it("échoue proprement sur un buffer qui n'est pas un zip", async () => {
    await expect(readZipEntries(Buffer.from("pas un zip"), () => true)).rejects.toThrow(/invalide|corrompue/);
  });
});

/* ------------------------------------------------------------------ */
/* OpenDocument (ODT/ODS)                                              */
/* ------------------------------------------------------------------ */

describe("opendocumentToText — ODT réellement converti", () => {
  it("extrait les paragraphes text:p du content.xml", async () => {
    const odt = zipMinimal([
      ["mimetype", "application/vnd.oasis.opendocument.text"],
      [
        "content.xml",
        '<office:document-content><office:body><office:text>' +
          '<text:p>Bonjour le monde.</text:p>' +
          '<text:p>Deuxième paragraphe.</text:p>' +
          '</office:text></office:body></office:document-content>',
      ],
    ]);
    const text = await opendocumentToText(odt);
    expect(text).toContain("Bonjour le monde.");
    expect(text).toContain("Deuxième paragraphe.");
    expect(text).not.toContain("text:p");
  });
});

describe("odsToText — classeur OpenDocument réellement converti", () => {
  it("extrait les cellules en lignes CSV", async () => {
    const ods = zipMinimal([
      [
        "content.xml",
        '<office:document-content><office:body><office:spreadsheet>' +
          '<table:table><table:table-row><table:table-cell><text:p>Nom</text:p></table:table-cell><table:table-cell><text:p>Ville</text:p></table:table-cell></table:table-row>' +
          '<table:table-row><table:table-cell><text:p>Dupont</text:p></table:table-cell><table:table-cell><text:p>Douala</text:p></table:table-cell></table:table-row>' +
          '</table:table></office:spreadsheet></office:body></office:document-content>',
      ],
    ]);
    const text = await odsToText(ods);
    expect(text).toContain('"Nom","Ville"');
    expect(text).toContain('"Dupont","Douala"');
  });

  it("retombe sur le texte général quand il n'y a pas de tableau", async () => {
    const ods = zipMinimal([
      [
        "content.xml",
        '<office:document-content><office:body><office:text><text:p>Notes de projet.</text:p></office:text></office:body></office:document-content>',
      ],
    ]);
    const text = await odsToText(ods);
    expect(text).toContain("Notes de projet.");
  });
});

/* ------------------------------------------------------------------ */
/* PPTX — tri numérique des diapositives                               */
/* ------------------------------------------------------------------ */

describe("pptxToText — présentation réellement convertie", () => {
  it("extrait les diapositives dans l'ordre numérique (1, 2, 10)", async () => {
    const pptx = zipMinimal([
      ["ppt/slides/slide10.xml", "<p:spTree><a:p><a:t>Diapo dix</a:t></a:p></p:spTree>"],
      ["ppt/slides/slide1.xml", "<p:spTree><a:p><a:t>Diapo un</a:t></a:p></p:spTree>"],
      ["ppt/slides/slide2.xml", "<p:spTree><a:p><a:t>Diapo deux</a:t></a:p></p:spTree>"],
    ]);
    const text = await pptxToText(pptx);
    const positionUn = text.indexOf("Diapo un");
    const positionDeux = text.indexOf("Diapo deux");
    const positionDix = text.indexOf("Diapo dix");
    expect(positionUn).toBeGreaterThan(-1);
    expect(positionDeux).toBeGreaterThan(positionUn);
    expect(positionDix).toBeGreaterThan(positionDeux);
  });
});

/* ------------------------------------------------------------------ */
/* EPUB                                                                */
/* ------------------------------------------------------------------ */

describe("epubToText — livre réellement converti", () => {
  it("extrait le texte des chapitres XHTML", async () => {
    const epub = zipMinimal([
      ["mimetype", "application/epub+zip"],
      ["OEBPS/chapitre1.xhtml", "<html><body><p>Premier chapitre.</p></body></html>"],
      ["OEBPS/chapitre2.xhtml", "<html><body><p>Second chapitre.</p></body></html>"],
    ]);
    const text = await epubToText(epub);
    expect(text).toContain("Premier chapitre.");
    expect(text).toContain("Second chapitre.");
    expect(text.indexOf("Premier")).toBeLessThan(text.indexOf("Second"));
  });
});

/* ------------------------------------------------------------------ */
/* RTF                                                                 */
/* ------------------------------------------------------------------ */

describe("rtfToText — débalisage réel", () => {
  it("convertit \\par en retours ligne et garde le texte", () => {
    const rtf = "{\\rtf1\\ansi Bonjour le monde.\\par Deuxi\\u232?me ligne.}";
    const text = rtfToText(rtf);
    expect(text).toContain("Bonjour le monde.");
    expect(text).toContain("\n");
    expect(text).toContain("Deuxi");
    expect(text).not.toContain("\\par");
  });

  it("ignore les destinations {\\* ...} et les échappements d'accolades", () => {
    const rtf = "{\\rtf1 Texte {\\*\\fldinst CACHE_AIGNORER} avec \\{accolades\\} visibles.}";
    const text = rtfToText(rtf);
    expect(text).toContain("Texte avec {accolades} visibles.");
    expect(text).not.toContain("CACHE_AIGNORER");
  });

  it("décodé \\uN vers le caractère Unicode (é = \\u232?)", () => {
    const text = rtfToText("{\\rtf1 caf\\u233? au lait}");
    expect(text).toContain("café au lait");
  });

  it("ne touche pas à un texte qui n'est pas RTF", () => {
    expect(rtfToText("simple texte")).toBe("simple texte");
  });
});
