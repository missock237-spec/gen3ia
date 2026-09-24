import { describe, expect, it } from "vitest";

import { htmlToText, extractTextFromUpload } from "./ingestion";

describe("htmlToText — extraction de texte de page web", () => {
  it("supprime scripts, styles et balises en conservant le contenu", () => {
    const html = `<!doctype html><html><head><style>p{color:red}</style><script>console.log("x")</script></head>
      <body><h1>Titre</h1><p>Premier paragraphe avec du contenu utile.</p><ul><li>Point un</li><li>Point deux</li></ul></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Titre");
    expect(text).toContain("Premier paragraphe avec du contenu utile.");
    expect(text).toContain("Point un");
    expect(text).not.toContain("console.log");
    expect(text).not.toContain("color:red");
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it("décode les entités HTML courantes", () => {
    expect(htmlToText("<p>A &amp; B &lt;tag&gt; &#39;quote&#39;</p>")).toContain("A & B <tag> 'quote'");
  });

  it("génère des sauts de ligne entre blocs (lisibilité du chunking)", () => {
    const text = htmlToText("<div>Un</div><div>Deux</div>");
    expect(text).toMatch(/Un\s*\n+\s*Deux/);
  });
});

describe("extractTextFromUpload — garde-fous de format", () => {
  it("refuse les PDF avec un message explicite et actionnable", async () => {
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "doc.pdf", { type: "application/pdf" });
    await expect(extractTextFromUpload(pdf)).rejects.toThrow(/PDF/);
  });

  it("refuse les formats non texte avec la liste des formats acceptés", async () => {
    const binary = new File([new Uint8Array([0x00, 0x01, 0x02])], "image.png", { type: "image/png" });
    await expect(extractTextFromUpload(binary)).rejects.toThrow(/DOCX/);
  });

  it("extrait le texte d'un fichier markdown en UTF-8", async () => {
    const md = new File(["# Titre\n\nContenu **important**."], "notes.md", { type: "text/markdown" });
    const result = await extractTextFromUpload(md);
    expect(result.text).toContain("Contenu **important**.");
    expect(result.mimeType).toContain("text/");
  });

  it("convertit le HTML téléversé en texte brut", async () => {
    const html = new File(["<html><body><p>Bonjour le monde</p></body></html>"], "page.html", { type: "text/html" });
    const result = await extractTextFromUpload(html);
    expect(result.text).toContain("Bonjour le monde");
    expect(result.text).not.toContain("<p>");
  });
});
