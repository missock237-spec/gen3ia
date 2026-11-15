import { describe, expect, it } from "vitest";
import { DocumentPlanSchema, sanitizeDocumentPlan } from "./types";

describe("sanitizeDocumentPlan (Task 114)", () => {
  it("type de bloc inconnu → paragraph (ne rejette plus la mission)", () => {
    const out = DocumentPlanSchema.parse(sanitizeDocumentPlan({
      title: "Plan",
      format: "pdf",
      blocks: [{ type: "summarySection", text: "Résumé du projet." }],
    }));
    expect(out.blocks[0].type).toBe("paragraph");
    expect(out.blocks[0].text).toBe("Résumé du projet.");
  });

  it("alias h2/sous-titre → heading, bullet → list", () => {
    const out = DocumentPlanSchema.parse(sanitizeDocumentPlan({
      title: "Rapport",
      format: "docx",
      blocks: [
        { type: "h2", text: "Contexte" },
        { type: "sous-titre", text: "Marché" },
        { type: "bullet", items: ["A", "B"] },
      ],
    }));
    expect(out.blocks.map((b) => b.type)).toEqual(["heading", "heading", "list"]);
  });

  it("url invalide réparée (www → https) ou retirée — plus jamais invalid_format", () => {
    const out = DocumentPlanSchema.parse(sanitizeDocumentPlan({
      title: "Doc",
      format: "pdf",
      blocks: [
        { type: "image", url: "www.example.com/visuel.png" },
        { type: "image", url: "pas une url" },
      ],
    }));
    expect(out.blocks[0].url).toBe("https://www.example.com/visuel.png");
    expect(out.blocks[1].url).toBeUndefined();
    expect(out.blocks[1].type).toBe("image");
  });

  it("blocs vides → paragraphe de secours (jamais min(1) violé)", () => {
    const out = DocumentPlanSchema.parse(sanitizeDocumentPlan({
      title: "Vide",
      format: "pdf",
      blocks: [null, "", 42],
    }));
    expect(out.blocks.length).toBe(1);
    expect(out.blocks[0].type).toBe("paragraph");
  });

  it("champs alternatifs (content/value/src) acceptés", () => {
    const out = DocumentPlanSchema.parse(sanitizeDocumentPlan({
      title: "Alt",
      format: "pdf",
      blocks: [{ type: "text", content: "Contenu alternatif" }, { type: "picture", src: "https://x.test/i.png" }],
    }));
    expect(out.blocks[0].text).toBe("Contenu alternatif");
    expect(out.blocks[1].url).toBe("https://x.test/i.png");
  });
});
