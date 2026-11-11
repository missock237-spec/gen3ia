import yauzl from "yauzl";
import { describe, expect, it } from "vitest";

import { generateDocument } from "./index";
import { validateArtifact } from "../validator";
import { analyzeArtifact } from "../analyzer";
import type { DocumentPlan } from "../types";

// ────────────────────────────────────────────────────────────────────────────
// Moteur documentaire — génération OpenDocument (ODT/ODS/ODP) réelle :
 // conteneur ZIP conforme (mimetype en première entrée, non compressé),
// content.xml porteur du contenu, relecture par le même analyste que les
// documents importés (boucle création → analyse sans perte).
// ────────────────────────────────────────────────────────────────────────────

const PLAN_BASE = {
  title: "Rapport trimestriel — Café Éclat",
  blocks: [
    { type: "title", text: "Rapport trimestriel" },
    { type: "heading", text: "Ventes par région", level: 2 },
    {
      type: "paragraph",
      text: "Les ventes progressent de 12 % sur le trimestre. Accents : éàçùœ — Émoji ignoré proprement.",
    },
    { type: "list", ordered: false, items: ["Sud : +18 %", "Nord : +6 %"] },
    {
      type: "table",
      columns: ["Région", "CA (k€)"],
      rows: [["Sud", "412"], ["Nord", "288"]],
    },
  ],
} as const;

function plan(format: DocumentPlan["format"]): DocumentPlan {
  return { ...PLAN_BASE, format } as DocumentPlan;
}

interface LectureZip {
  premiereEntree: string | null;
  mimetype: string | null;
  contentXml: string | null;
  entrees: string[];
}

async function lireZip(buffer: Buffer): Promise<LectureZip> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (erreur, zip) => {
      if (erreur || !zip) return reject(erreur instanceof Error ? erreur : new Error("zip illisible"));
      const entrees: string[] = [];
      let premiereEntree: string | null = null;
      let mimetype: string | null = null;
      let contentXml: string | null = null;
      let traitées = 0;
      const finir = () => {
        zip.close();
        resolve({ premiereEntree, mimetype, contentXml, entrees });
      };
      zip.on("entry", (entree: yauzl.Entry) => {
        if (premiereEntree === null) premiereEntree = entree.fileName;
        entrees.push(entree.fileName);
        if (entree.fileName !== "mimetype" && entree.fileName !== "content.xml") {
          traitées += 1;
          if (traitées >= zip.entryCount) finir();
          else zip.readEntry();
          return;
        }
        zip.openReadStream(entree, (erreurFlux, flux) => {
          if (erreurFlux || !flux) {
            traitées += 1;
            if (traitées >= zip.entryCount) finir();
            else zip.readEntry();
            return;
          }
          const morceaux: Buffer[] = [];
          flux.on("data", (m: Buffer) => morceaux.push(m));
          flux.on("end", () => {
            const texte = Buffer.concat(morceaux).toString("utf8");
            if (entree.fileName === "mimetype") mimetype = texte;
            if (entree.fileName === "content.xml") contentXml = texte;
            traitées += 1;
            if (traitées >= zip.entryCount) finir();
            else zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

describe("générateur OpenDocument (odt / ods / odp)", () => {
  it("produit un ODT conforme : mimetype en première entrée + content.xml lisible", async () => {
    const data = await generateDocument(plan("odt"));
    expect(data.length).toBeGreaterThan(500);
    expect(data.subarray(0, 2).toString("hex")).toBe("504b");

    const lu = await lireZip(data);
    expect(lu.premiereEntree).toBe("mimetype");
    expect(lu.mimetype).toBe("application/vnd.oasis.opendocument.text");
    expect(lu.contentXml).toContain("Rapport trimestriel");
    expect(lu.contentXml).toContain("Ventes par région");
    expect(lu.contentXml).toContain("text:h");
    // Tableau réel : colonnes nommées + cellules du corps.
    expect(lu.contentXml).toContain("table:table");
    expect(lu.contentXml).toContain("412");
  });

  it("produit un ODS dont le content.xml contient les lignes du classeur", async () => {
    const data = await generateDocument(plan("ods"));
    const lu = await lireZip(data);
    expect(lu.mimetype).toBe("application/vnd.oasis.opendocument.spreadsheet");
    expect(lu.contentXml).toContain("table:table");
    expect(lu.contentXml).toContain("Région");
    expect(lu.contentXml).toContain("288");
  });

  it("produit un ODP avec une diapositive par intertitre", async () => {
    const data = await generateDocument(plan("odp"));
    const lu = await lireZip(data);
    expect(lu.mimetype).toBe("application/vnd.oasis.opendocument.presentation");
    expect(lu.contentXml).toContain("draw:page");
    expect(lu.contentXml).toContain("Rapport trimestriel");
    expect(lu.contentXml).toContain("Ventes par région");
  });

  it("boucle création → analyse : l'analyste extrait le texte réel de l'ODT", async () => {
    const data = await generateDocument(plan("odt"));
    const analyse = await analyzeArtifact({ filename: "rapport.odt", data });
    expect(analyse.safe).toBe(true);
    expect(analyse.extractedText).toContain("Rapport trimestriel");
    expect(analyse.extractedText).toContain("progressent de 12");
  });

  it("le validateur rejette un ODT falsifié (signature non ZIP)", () => {
    const faux = Buffer.from("je fais semblant d'être un odt", "utf8");
    const validation = validateArtifact("odt", faux);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain("OpenDocument");
  });
});
