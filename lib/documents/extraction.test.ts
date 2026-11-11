import { describe, expect, it } from "vitest";

import { extraireContenuDocument } from "./extraction";
import { lireTar } from "@/lib/files/tar-text";

// ────────────────────────────────────────────────────────────────────────────
// Cœur d'extraction unifié — chaque format est reconstruit RÉELLEMENT dans
// le test (docx via docx, xlsx via exceljs, pdf via pdf-lib, tar octet par
// octet) puis relu : la boucle génération → extraction est la preuve du
// zéro fantôme.
// ────────────────────────────────────────────────────────────────────────────

const TAILLE_BLOC = 512;

function enteteTar(chemin: string, donnees: Buffer): Buffer {
  const bloc = Buffer.alloc(TAILLE_BLOC);
  bloc.write(chemin.slice(0, 99), 0, "utf8");
  bloc.write("0000644\0", 100, "ascii");
  bloc.write("0001750\0", 108, "ascii");
  bloc.write("0001750\0", 116, "ascii");
  bloc.write(donnees.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  bloc.write("00000000000\0", 136, "ascii");
  bloc.write("        ", 148, "ascii");
  bloc.write("0", 156, "ascii");
  bloc.write("ustar\0", 257, "ascii");
  bloc.write("00", 263, "ascii");
  let somme = 0;
  for (const octet of bloc) somme += octet;
  bloc.write(somme.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return bloc;
}

async function docxReel(): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun } = await import("docx");
  const doc = new Document({
    sections: [{ children: [new Paragraph({ children: [new TextRun("Contrat de prestation signé.")] })] }],
  });
  return Packer.toBuffer(doc);
}

async function xlsxReel(): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const feuille = wb.addWorksheet("Ventes");
  feuille.addRow(["Région", "CA"]);
  feuille.addRow(["Sud", 412]);
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

async function pdfReel(): Promise<Buffer> {
  // Utilise le VRAI générateur de la plateforme (pas un PDF artificiel) :
  // la boucle testée est exactement celle de production création → analyse.
  const { generateDocument } = await import("@/lib/documents/generators");
  return generateDocument({
    title: "GEN3IA extraction native",
    format: "pdf",
    blocks: [{ type: "paragraph", text: "GEN3IA extraction native du contenu." }],
  } as Parameters<typeof generateDocument>[0]);
}

describe("extraction documentaire unifiée", () => {
  it("extrait le texte d'un DOCX reconstruit réellement", async () => {
    const contenu = await extraireContenuDocument(await docxReel(), "contrat.docx");
    expect(contenu.kind).toBe("docx");
    expect(contenu.texte).toContain("Contrat de prestation");
  });

  it("extrait tableau + texte d'un XLSX reconstruit réellement", async () => {
    const contenu = await extraireContenuDocument(await xlsxReel(), "ventes.xlsx");
    expect(contenu.kind).toBe("xlsx");
    expect(contenu.feuilles).toBe(1);
    expect(contenu.tableau?.colonnes).toEqual(["Région", "CA"]);
    expect(contenu.tableau?.lignes[0]).toEqual(["Sud", "412"]);
  });

  it("extrait le texte natif d'un PDF généré réellement", async () => {
    const contenu = await extraireContenuDocument(await pdfReel(), "note.pdf");
    expect(contenu.kind).toBe("pdf");
    expect(contenu.pages).toBe(1);
    expect(contenu.texte).toContain("GEN3IA");
  });

  it("structure un CSV en colonnes/lignes prêtes pour un bloc tableau", async () => {
    const csv = Buffer.from("Produit;Prix\nCafé;3,5\nThé;2,8\n", "utf8");
    const contenu = await extraireContenuDocument(csv, "tarifs.csv");
    expect(contenu.kind).toBe("csv");
    expect(contenu.tableau?.colonnes).toEqual(["Produit", "Prix"]);
    expect(contenu.tableau?.lignes).toEqual([["Café", "3,5"], ["Thé", "2,8"]]);
  });

  it("parse un YAML en structure réelle", async () => {
    const yaml = Buffer.from("titre: Manifeste\nequipe:\n  - Ada\n  - Grace\n", "utf8");
    const contenu = await extraireContenuDocument(yaml, "manifeste.yaml");
    expect(contenu.kind).toBe("yaml");
    expect(contenu.structured).toEqual({ titre: "Manifeste", equipe: ["Ada", "Grace"] });
  });

  it("liste et lit une archive TAR réelle", async () => {
    const contenu = Buffer.from("Journal du projet Gen3ia.", "utf8");
    const tar = Buffer.concat([
      enteteTar("journal.txt", contenu),
      contenu,
      Buffer.alloc((TAILLE_BLOC - (contenu.length % TAILLE_BLOC)) % TAILLE_BLOC),
      Buffer.alloc(TAILLE_BLOC * 2),
    ]);
    const extrait = await extraireContenuDocument(tar, "sauvegarde.tar");
    expect(extrait.kind).toBe("tar");
    expect(extrait.entrees?.[0].chemin).toBe("journal.txt");
    expect(extrait.texte).toContain("Journal du projet");
    expect(lireTar(tar).fichiersTexte).toHaveLength(1);
  });

  it("reconnaît un 7z par sa signature et le refuse honnêtement", async () => {
    const sept = Buffer.concat([
      Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
      Buffer.alloc(24, 1),
    ]);
    const contenu = await extraireContenuDocument(sept, "archive.7z");
    expect(contenu.kind).toBe("7z");
    expect(contenu.conversion).toBe("metadata-only");
    expect(contenu.note).toContain("zip ou .tar");
  });

  it("mesure les dimensions réelles d'une image importée", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const contenu = await extraireContenuDocument(png, "capture.png");
    expect(contenu.dimensions).toEqual({ format: "png", largeur: 1, hauteur: 1 });
    expect(contenu.note).toContain("1×1");
  });

  it("extrait le texte d'un XML simple", async () => {
    const xml = Buffer.from("<catalogue><livre>Antigone</livre></catalogue>", "utf8");
    const contenu = await extraireContenuDocument(xml, "catalogue.xml");
    expect(contenu.kind).toBe("xml");
    expect(contenu.texte).toContain("Antigone");
  });
});
