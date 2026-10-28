import { beforeEach, describe, expect, it, vi } from "vitest";

// loadImportedFilesContext touche R2 (filet de compatibilité { path }) et
// Firestore (fileId) : les deux sont mockés — la conversion, elle, est RÉELLE.
const docStore = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock("@/lib/storage/r2", () => ({
  downloadFromR2: vi.fn(),
  isR2Configured: vi.fn(() => true),
  uploadToR2: vi.fn(),
}));
vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: () => ({
      doc: (id: string) => ({
        get: async () => {
          const data = docStore.get(id);
          return data ? { exists: true, id, data: () => data } : { exists: false, id, data: () => undefined };
        },
      }),
    }),
  },
}));

import { downloadFromR2 } from "@/lib/storage/r2";
import {
  convertFileBuffer,
  convertUploadedFile,
  detectCsvDelimiter,
  loadImportedFilesContext,
  parseCsv,
  pdfToText,
} from "./import";

const mockedDownload = vi.mocked(downloadFromR2);

const USER = "user-1";
const PREFIX = `users/${USER}/permanent/`;

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
    Object.defineProperty(big, "size", { value: 52_500_000 });
    await expect(convertUploadedFile(big)).rejects.toThrow(/trop volumineux/);
  });
});

/**
 * CONTEXTE MODÈLE — loadImportedFilesContext :
 *  - fileId → contenu relu de la base (Firestore mocké, données réelles) ;
 *  - FILET DE COMPATIBILITÉ { path } (fileId absent) : lecture R2 à la volée
 *    + conversion RÉELLE (le convertisseur n'est PAS mocké), mêmes budgets,
 *    cloisonnement strict au stockage permanent du propriétaire.
 */
describe("loadImportedFilesContext — contenu réel injecté au tour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docStore.clear();
  });

  it("retourne une chaîne vide sans pièce jointe", async () => {
    await expect(loadImportedFilesContext(USER, undefined)).resolves.toBe("");
    await expect(loadImportedFilesContext(USER, [])).resolves.toBe("");
  });

  it("charge le contenu réel d'un attachment réduit à { path } (filet de compatibilité)", async () => {
    mockedDownload.mockResolvedValue(Buffer.from("Contenu réel du rapport annuel.") as never);
    const contexte = await loadImportedFilesContext(USER, [
      { path: `${PREFIX}rapport.txt`, filename: "rapport.txt", contentType: "text/plain" },
    ]);
    expect(mockedDownload).toHaveBeenCalledOnce();
    expect(contexte).toContain("Contenu RÉEL des fichiers importés");
    expect(contexte).toContain("rapport.txt");
    expect(contexte).toContain("Contenu réel du rapport annuel.");
    // Le filet est annoncé honnêtement (le contenu ne vient PAS de la base).
    expect(contexte).toContain("lecture directe du stockage permanent");
  });

  it("refuse un chemin hors du stockage permanent du propriétaire (cloisonnement)", async () => {
    mockedDownload.mockResolvedValue(Buffer.from("secret") as never);
    const contexte = await loadImportedFilesContext(USER, [
      { path: "users/autre-utilisateur/permanent/f.txt", filename: "f.txt", contentType: "text/plain" },
    ]);
    expect(mockedDownload).not.toHaveBeenCalled();
    expect(contexte).toContain("f.txt");
    expect(contexte).toContain("hors du stockage permanent");
  });

  it("annonce honnêtement les métadonnées d'une image (moteur textuel, rien d'inventé)", async () => {
    mockedDownload.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]) as never);
    const contexte = await loadImportedFilesContext(USER, [
      { path: `${PREFIX}photo.png`, filename: "photo.png", contentType: "image/png" },
    ]);
    expect(contexte).toContain("photo.png");
    expect(contexte).toContain("métadonnées seulement");
    expect(contexte).toContain("métadonnées stockées");
  });

  it("tronque le contenu au budget par fichier (12 000 caractères)", async () => {
    mockedDownload.mockResolvedValue(Buffer.from("x".repeat(20_000), "utf8") as never);
    const contexte = await loadImportedFilesContext(USER, [
      { path: `${PREFIX}gros.txt`, filename: "gros.txt", contentType: "text/plain" },
    ]);
    expect(contexte).not.toBe("");
    // Corps coupé au budget (12 000) — en-tête + titre du bloc en sus.
    expect(contexte.length).toBeLessThan(13_000);
  });

  it("respecte le budget total (60 000 caractères) sur un lot de fichiers", async () => {
    mockedDownload.mockImplementation(() => Promise.resolve(Buffer.from("x".repeat(20_000), "utf8")) as never);
    const attachments = Array.from({ length: 10 }, (_inutilise, index) => ({
      path: `${PREFIX}fichier-${index}.txt`,
      filename: `fichier-${index}.txt`,
      contentType: "text/plain",
    }));
    const contexte = await loadImportedFilesContext(USER, attachments);
    // 10 fichiers convertis mais le bloc reste borné (jamais de prompt illimité).
    expect(contexte.length).toBeLessThan(70_000);
  });

  it("mélange fileId (base de données) et path (lecture à la volée)", async () => {
    docStore.set("file-1", {
      id: "file-1",
      userId: USER,
      filename: "ventes.csv",
      contentType: "text/csv",
      sizeBytes: 30,
      kind: "csv",
      conversion: "full",
      charCount: 23,
      createdAt: new Date().toISOString(),
      textContent: "produit,prix\nCafé,1500",
    });
    mockedDownload.mockResolvedValue(Buffer.from("Notes de réunion réelles.") as never);
    const contexte = await loadImportedFilesContext(USER, [
      { fileId: "file-1", filename: "ventes.csv" },
      { path: `${PREFIX}notes.txt`, filename: "notes.txt", contentType: "text/plain" },
    ]);
    expect(contexte).toContain("ventes.csv");
    expect(contexte).toContain("produit,prix");
    expect(contexte).toContain("notes.txt");
    expect(contexte).toContain("Notes de réunion réelles.");
  });

  it("ignore un fileId inconnu sans casser le reste du contexte", async () => {
    mockedDownload.mockResolvedValue(Buffer.from("Contenu du chemin secours.") as never);
    const contexte = await loadImportedFilesContext(USER, [
      { fileId: "inconnu-absent", filename: "perdu.pdf" },
      { path: `${PREFIX}secours.txt`, filename: "secours.txt", contentType: "text/plain" },
    ]);
    expect(contexte).not.toContain("perdu.pdf");
    expect(contexte).toContain("secours.txt");
    expect(contexte).toContain("Contenu du chemin secours.");
  });

  it("le titre reste « stockés en base de données » quand tout vient de la base", async () => {
    docStore.set("file-2", {
      id: "file-2",
      userId: USER,
      filename: "compte-rendu.txt",
      contentType: "text/plain",
      sizeBytes: 20,
      kind: "text",
      conversion: "full",
      charCount: 10,
      createdAt: new Date().toISOString(),
      textContent: "Texte stocké.",
    });
    const contexte = await loadImportedFilesContext(USER, [{ fileId: "file-2", filename: "compte-rendu.txt" }]);
    expect(contexte).toContain("Contenu RÉEL des fichiers importés (stockés en base de données)");
    expect(contexte).toContain("Texte stocké.");
  });
});

describe("convertFileBuffer — nouveaux formats bureautiques (dispatch réel)", () => {
  it(".doc binaire → métadonnées avec note actionnable (pas un muet)", async () => {
    // Un flux OLE minimal (signature réelle du header Word 97-2003).
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64, 0)]);
    const résultat = await convertFileBuffer(ole, "ancien.doc", "application/msword", ole.length);
    expect(résultat.conversion).toBe("metadata-only");
    expect(résultat.note).toContain(".docx");
  });

  it(".rtf → texte débalisé (full)", async () => {
    const rtf = Buffer.from("{\\rtf1\\ansi Contrat de bail.\\par Article 1 : objet du bail.}", "utf8");
    const résultat = await convertFileBuffer(rtf, "contrat.rtf", "application/rtf", rtf.length);
    expect(résultat.kind).toBe("rtf");
    expect(résultat.conversion).toBe("full");
    expect(résultat.text).toContain("Contrat de bail.");
    expect(résultat.text).toContain("Article 1 : objet du bail.");
  });

  it(".odt → texte des paragraphes (full)", async () => {
    // ZIP stored minimal — même structure que le helper du test office-text
    // (locals d'abord, central directory ensuite, EOCD en dernier).
    const table = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
      return t;
    })();
    const crc32 = (d: Buffer) => { let c = 0xffffffff; for (const o of d) c = table[(c ^ o) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const entries: Array<[string, Buffer]> = [
      ["mimetype", Buffer.from("application/vnd.oasis.opendocument.text")],
      ["content.xml", Buffer.from('<office:document-content><office:body><office:text><text:p>Rapport annuel 2026.</text:p><text:p>Chiffres consolidés.</text:p></office:text></office:body></office:document-content>')],
    ];
    const locals: Buffer[] = [];
    const centraux: Buffer[] = [];
    let offset = 0;
    for (const [name, data] of entries) {
      const nom = Buffer.from(name);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
      local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nom.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
      central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nom.length, 28); central.writeUInt32LE(offset, 42);
      locals.push(local, nom, data);
      centraux.push(central, nom);
      offset += 30 + nom.length + data.length;
    }
    const tailleCentrale = centraux.reduce((t, b) => t + b.length, 0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(2, 8); eocd.writeUInt16LE(2, 10);
    eocd.writeUInt32LE(tailleCentrale, 12); eocd.writeUInt32LE(offset, 16);
    const zip = Buffer.concat([...locals, ...centraux, eocd]);
    const résultat = await convertFileBuffer(zip, "rapport.odt", "application/vnd.oasis.opendocument.text", zip.length);
    expect(résultat.kind).toBe("odt");
    expect(résultat.conversion).toBe("full");
    expect(résultat.text).toContain("Rapport annuel 2026.");
    expect(résultat.text).toContain("Chiffres consolidés.");
  });
});
