import { describe, expect, it } from "vitest";

import {
  convertUploadedFile,
  detectCsvDelimiter,
  parseCsv,
  pdfToText,
} from "./import";

describe("detectCsvDelimiter + parseCsv — conversion CSV réelle", () => {
  it("détecte le point-virgule", () => {
    expect(detectCsvDelimiter("a;b;c\n1;2;3")).toBe(";");
  });

  it("détecte la virgule", () => {
    expect(detectCsvDelimiter("a,b,c\n1,2,3")).toBe(",");
  });

  it("parse les guillemets, échappements et multi-lignes", () => {
    const parsed = parseCsv('name,city\n"Dupont, Marc",Douala\n"Luc ""Lebg""",Paris');
    expect(parsed.headers).toEqual(["name", "city"]);
    expect(parsed.rows[0]).toEqual(["Dupont, Marc", "Douala"]);
    expect(parsed.rows[1]).toEqual(['Luc "Lebg"', "Paris"]);
  });
});

describe("pdfToText — extraction de texte PDF native", () => {
  it("extrait le texte d'un PDF natif à flux non compressé", () => {
    const content = "BT /F1 12 Tf (Bonjour le monde, ceci est un test de conversion reelle.) Tj T* (Deuxieme ligne de contenu suffisant.) Tj ET";
    const pdf = Buffer.from(
      `4 0 obj << /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj`,
      "latin1",
    );
    const result = pdfToText(pdf);
    expect(result.text).toContain("Bonjour le monde");
    expect(result.text).toContain("Deuxieme ligne");
  });

  it("renvoie un texte vide pour un PDF sans flux de texte (scan)", () => {
    const result = pdfToText(Buffer.from("%PDF-1.4 rien d'exploitable ici", "latin1"));
    expect(result.text).toBe("");
  });
});

describe("convertUploadedFile — conversion réelle par type", () => {
  it("convertit un CSV en lignes structurées", async () => {
    const file = new File(["produit,prix\nCafé,1500\nThé,1000"], "ventes.csv", { type: "text/csv" });
    const result = await convertUploadedFile(file);
    expect(result.kind).toBe("csv");
    expect(result.conversion).toBe("full");
    expect(result.rowCount).toBe(2);
    const structured = result.structured as { headers: string[]; rows: string[][] };
    expect(structured.headers).toEqual(["produit", "prix"]);
    expect(structured.rows[1]).toEqual(["Thé", "1000"]);
  });

  it("convertit un JSON en structure", async () => {
    const file = new File([JSON.stringify({ clients: ["Marc", "Léa"], total: 42 })], "data.json", { type: "application/json" });
    const result = await convertUploadedFile(file);
    expect(result.kind).toBe("json");
    expect(result.structured).toEqual({ clients: ["Marc", "Léa"], total: 42 });
  });

  it("convertit du texte brut", async () => {
    const file = new File(["Compte rendu de réunion :\n- point un\n- point deux"], "notes.txt", { type: "text/plain" });
    const result = await convertUploadedFile(file);
    expect(result.kind).toBe("text");
    expect(result.text).toContain("point deux");
  });

  it("convertit un HTML en texte lisible", async () => {
    const file = new File(["<html><body><h1>Rapport</h1><p>Contenu utile ici.</p></body></html>"], "page.html", { type: "text/html" });
    const result = await convertUploadedFile(file);
    expect(result.kind).toBe("html");
    expect(result.text).toContain("Rapport");
    expect(result.text).not.toContain("<h1>");
  });

  it("traite une image en métadonnées sans faux texte", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "photo.png", { type: "image/png" });
    const result = await convertUploadedFile(file);
    expect(result.kind).toBe("image");
    expect(result.conversion).toBe("metadata-only");
  });

  it("signale honnêtement un PDF sans texte natif (scan)", async () => {
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])], "scan.pdf", { type: "application/pdf" });
    const result = await convertUploadedFile(file);
    expect(result.kind).toBe("pdf");
    expect(result.conversion).toBe("metadata-only");
    expect(result.note).toMatch(/PDF/);
  });

  it("conserve du JSON invalide en texte brut", async () => {
    const file = new File(["{ cassé"], "broken.json", { type: "application/json" });
    const result = await convertUploadedFile(file);
    expect(result.kind).toBe("json");
    expect(result.text).toContain("cassé");
    expect(result.note).toMatch(/JSON invalide/);
  });

  it("refuse les fichiers trop volumineux", async () => {
    const big = new File([new Uint8Array(10)], "huge.txt", { type: "text/plain" });
    Object.defineProperty(big, "size", { value: 21_000_000 });
    await expect(convertUploadedFile(big)).rejects.toThrow(/trop volumineux/);
  });
});
