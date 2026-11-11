import { describe, expect, it } from "vitest";

import { construirePlanDepuisContenu } from "./convert-document";
import { generateArtifact } from "@/lib/documents/engine";
import { validateArtifact } from "@/lib/documents/validator";
import { extraireContenuDocument } from "@/lib/documents/extraction";

// ────────────────────────────────────────────────────────────────────────────
// Outil artifact.convert — cœur PUR (extraction → plan → génération) testé
// de bout en bout sans stockage : CSV → XLSX et texte → RTF réellement
// générés et revalidés.
// ────────────────────────────────────────────────────────────────────────────

describe("construirePlanDepuisContenu (cœur pur de la conversion)", () => {
  it("traduit un contenu en blocs : titre + tableau + paragraphes", () => {
    const plan = construirePlanDepuisContenu(
      {
        kind: "csv",
        texte: "Ville,CA\nLyon,99",
        tableau: { colonnes: ["Ville", "CA"], lignes: [["Lyon", "99"]] },
        conversion: "full",
      },
      "xlsx",
      "Tarifs convertis",
    );
    expect(plan.title).toBe("Tarifs convertis");
    expect(plan.blocks[0]).toMatchObject({ type: "title" });
    const tableau = plan.blocks.find((b) => b.type === "table");
    expect(tableau).toMatchObject({ columns: ["Ville", "CA"] });
    expect(plan.description).toContain("csv → xlsx");
  });

  it("annonce les pertes quand le contenu est tronqué", () => {
    const lignes = Array.from({ length: 500 }, (_, i) => [`l${i}`]);
    const plan = construirePlanDepuisContenu(
      {
        kind: "csv",
        texte: "trop long",
        tableau: { colonnes: ["A"], lignes },
        conversion: "full",
      },
      "pdf",
      "Gros tableau",
    );
    expect(plan.description).toContain("tronqué à 300 lignes");
  });

  it("échoue HONNÊTEMENT sur une source sans contenu extractible", () => {
    expect(() =>
      construirePlanDepuisContenu(
        { kind: "7z", texte: "", conversion: "metadata-only", note: "LZMA non incluse" },
        "docx",
        "Impossible",
      ),
    ).toThrow(/Aucun contenu extractible.*LZMA non incluse/s);
  });
});

describe("conversion réelle de bout en bout (sans stockage)", () => {
  it("convertit un CSV en XLSX valide", async () => {
    const csv = Buffer.from("Produit;Stock\nCafé;120\nThé;80\n", "utf8");
    const contenu = await extraireContenuDocument(csv, "inventaire.csv");
    const plan = construirePlanDepuisContenu(contenu, "xlsx", "Inventaire (XLSX)");
    const genere = await generateArtifact({
      userId: "utilisateur-test",
      plan: plan as Parameters<typeof generateArtifact>[0]["plan"],
    });
    expect(genere.filename).toContain(".xlsx");
    expect(genere.validation.valid).toBe(true);

    // Boucle inverse : le XLSX produit est relu par le cœur d'extraction.
    // Comportement réel documenté : le générateur écrit le titre en première
    // ligne (→ « colonnes » de la relecture), les données suivent dans le
    // texte intégral.
    const relu = await extraireContenuDocument(genere.data, genere.filename);
    expect(relu.kind).toBe("xlsx");
    expect(relu.feuilles).toBe(1);
    expect(relu.texte).toContain("Produit");
    expect(relu.texte).toContain("Café");
    expect(relu.texte).toContain("120");
    expect(relu.texte).toContain("Thé");
  });

  it("convertit un texte importé en RTF valide", async () => {
    const texte = Buffer.from("Compte rendu de reunion.\nPoint un : budget valide.", "utf8");
    const contenu = await extraireContenuDocument(texte, "compte-rendu.txt");
    const plan = construirePlanDepuisContenu(contenu, "rtf", "Compte rendu (RTF)");
    const genere = await generateArtifact({
      userId: "utilisateur-test",
      plan: plan as Parameters<typeof generateArtifact>[0]["plan"],
    });
    expect(genere.filename).toContain(".rtf");
    expect(genere.data.toString("latin1")).toContain("{\\rtf1");
    expect(validateArtifact("rtf", genere.data).valid).toBe(true);
  });

  it("convertit un texte en ODT conforme (mimetype OpenDocument)", async () => {
    const texte = Buffer.from("Memo important.\nVerifier la ligne deux.", "utf8");
    const contenu = await extraireContenuDocument(texte, "memo.txt");
    const plan = construirePlanDepuisContenu(contenu, "odt", "Memo (ODT)");
    const genere = await generateArtifact({
      userId: "utilisateur-test",
      plan: plan as Parameters<typeof generateArtifact>[0]["plan"],
    });
    expect(genere.filename).toContain(".odt");
    expect(genere.data.subarray(30, 38).toString("ascii")).toBe("mimetype");
  });
});
