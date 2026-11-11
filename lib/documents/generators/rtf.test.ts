import { describe, expect, it } from "vitest";

import { generateDocument } from "./index";
import { generateRtf } from "./rtf";
import { validateArtifact } from "../validator";
import { sanitizeArtifactToolInput } from "../types";
import { DocumentPlanSchema } from "../types";
import type { DocumentPlan } from "../types";

// ────────────────────────────────────────────────────────────────────────────
// Moteur documentaire — RTF natif + YAML structuré : signatures, échappements
// Unicode réels (\uN), relecture par le validateur ; alias de formats du
// moteur (opendocument/calc/impress/richtext/yml) coercés côté outil.
// ────────────────────────────────────────────────────────────────────────────

function plan(format: DocumentPlan["format"]): DocumentPlan {
  return {
    title: "Note de synthèse",
    format,
    blocks: [
      { type: "title", text: "Note de synthèse" },
      { type: "paragraph", text: "Coût total : 1 200 €. Accentués : éàçùœ. Accolades { } et backslash \\ échappés." },
      { type: "list", ordered: true, items: ["Premier point", "Second point"] },
    ],
  } as DocumentPlan;
}

describe("générateur RTF", () => {
  it("produit un RTF valide avec échappements réels", () => {
    const data = generateRtf(plan("rtf"));
    const texte = data.toString("latin1");
    expect(texte.startsWith("{\\rtf1\\ansi")).toBe(true);
    expect(texte.endsWith("}")).toBe(true);
    // Échappement des caractères spéciaux RTF.
    expect(texte).toContain("\\{ \\}");
    expect(texte).toContain("\\\\");
    // Unicode signé : € (U+20AC = 8364, < 32768 → positif) → \u8364?.
    expect(texte).toContain("\\u8364?");
    // Accents hors ASCII → \uN également.
    expect(texte).toContain("\\u");
    // Titre en gras (le « è » part en \uN — on vérifie le préfixe gras),
    // listes numérotées.
    expect(texte).toContain("{\\b Note de synth");
    expect(texte).toContain("1. Premier point");
  });

  it("passe la validation de signature du validateur", () => {
    const data = generateRtf(plan("rtf"));
    const validation = validateArtifact("rtf", data);
    expect(validation.valid).toBe(true);
    expect(validation.mimeType).toBe("application/rtf");
  });

  it("le validateur rejette un RTF falsifié", () => {
    const validation = validateArtifact("rtf", Buffer.from("plain text", "utf8"));
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain("RTF");
  });
});

describe("générateur YAML structuré", () => {
  it("produit un YAML rechargeable contenant titre, liste et tableau", async () => {
    const p = plan("yaml");
    p.blocks.push({
      type: "table",
      columns: ["Ville", "CA"],
      rows: [["Lyon", "99"]],
    } as DocumentPlan["blocks"][number]);
    const data = await generateDocument(p);
    const texte = data.toString("utf8");
    expect(texte).toContain("titre: Note de synthèse");
    expect(texte).toContain("éléments:");
    expect(texte).toContain("Premier point");
    expect(texte).toContain("Ville");

    // Reliure réelle : le validateur reparse le YAML généré.
    const validation = validateArtifact("yaml", data);
    expect(validation.valid).toBe(true);
  });

  it("le validateur signale un YAML invalide", () => {
    const validation = validateArtifact("yaml", Buffer.from("cle: [non fermé", "utf8"));
    expect(validation.valid).toBe(false);
  });
});

describe("alias de formats du moteur documentaire", () => {
  const cas: [string, string][] = [
    ["word", "docx"],
    ["opendocument", "odt"],
    ["writer", "odt"],
    ["calc", "ods"],
    ["impress", "odp"],
    ["richtext", "rtf"],
    ["texte riche", "rtf"],
    ["yml", "yaml"],
    ["tableur", "xlsx"],
  ];

  it.each(cas)("« %s » est coercé vers %s", (brut, attendu) => {
    const sanitizé = sanitizeArtifactToolInput({
      title: "Doc",
      format: brut,
      blocks: [{ type: "paragraph", text: "contenu" }],
    });
    const parsé = DocumentPlanSchema.parse(sanitizé);
    expect(parsé.format).toBe(attendu);
  });
});
