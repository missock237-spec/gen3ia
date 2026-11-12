import { describe, expect, it } from "vitest";

import {
  extraireBlocsCode,
  extraireFaits,
  extrairePairesTexte,
  extraireUnitesConnaissance,
  fusionnerExtractions,
  htmlVersTexte,
  nettoyerTexte,
} from "./extraction-corpus";

/* ------------------------------------------------------------------ */
/* EXTRACTION DE CORPUS — le découpage des ressources du Studio en     */
/* unités de connaissance doit être déterministe, plafonné honnêtement */
/* (compteurs réels) et couvrir les trois formes annoncées (Q/A,       */
/* faits, code) plus les datasets structurés json/jsonl/csv.           */
/* ------------------------------------------------------------------ */

describe("nettoyage de ressources", () => {
  it("normalise les fins de ligne et resserre les blancs", () => {
    const nettoye = nettoyerTexte("Première ligne\r\n\r\n\r\n\r\nDeuxième   ligne\n");
    expect(nettoye).toBe("Première ligne\n\nDeuxième   ligne");
  });

  it("dégraisse un HTML en texte (script/style retirés, entités décodées)", () => {
    const texte = htmlVersTexte(
      "<html><head><style>p{color:red}</style></head><body><h1>La Photosynthèse</h1>" +
        "<script>alert('x')</script><p>La lumière &amp; les plantes.</p></body></html>",
    );
    expect(texte).toContain("La Photosynthèse");
    expect(texte).toContain("La lumière & les plantes.");
    expect(texte).not.toContain("alert");
    expect(texte).not.toContain("color:red");
  });
});

describe("paires Q/A (blocs txt)", () => {
  it("extrait les blocs Q:/A: séparés par des lignes vides", () => {
    const paires = extrairePairesTexte(
      "Q: Qu'est-ce que la photosynthèse ?\nA: Le processus par lequel les plantes fabriquent du sucre avec la lumière.\n\nQ: Qui la réalise ?\nA: Les plantes vertes, les algues et certaines bactéries.\n",
    );
    expect(paires).toHaveLength(2);
    expect(paires[0]?.question).toBe("Qu'est-ce que la photosynthèse ?");
    expect(paires[0]?.reponse).toContain("fabriquent du sucre");
    expect(paires[1]?.question).toBe("Qui la réalise ?");
  });

  it("accepte les variantes Question:/Réponse: et les questions multi-lignes", () => {
    const paires = extrairePairesTexte(
      "Question: Décris le rôle des chloroplastes\ndans la cellule végétale.\nRéponse: Ce sont les organites où la lumière est convertie en énergie chimique.\n",
    );
    expect(paires).toHaveLength(1);
    expect(paires[0]?.question).toContain("chloroplastes");
    expect(paires[0]?.question).toContain("cellule végétale");
    expect(paires[0]?.reponse).toContain("organites");
  });

  it("ignore les blocs sans réponse (comptés par l'extraction complète)", () => {
    const paires = extrairePairesTexte("Q: Une question sans réponse ?\n\nQ: Une autre ?\nA: La réponse cette fois.\n");
    expect(paires).toHaveLength(1);
    expect(paires[0]?.question).toBe("Une autre ?");
  });
});

describe("faits de définition", () => {
  it("extrait « X est … » et dérive une question « Que sait-on sur X ? »", () => {
    const faits = extraireFaits(
      "La photosynthèse est le processus biologique par lequel les plantes transforment la lumière en énergie chimique. Les chloroplastes sont les organites cellulaires où elle se déroule.",
    );
    expect(faits).toHaveLength(2);
    expect(faits[0]?.sujet).toBe("La photosynthèse");
    expect(faits[0]?.fait).toContain("lumière en énergie chimique");
    expect(faits[1]?.sujet).toBe("Les chloroplastes");
  });

  it("ignore les phrases trop courtes ou sans verbe de définition", () => {
    const faits = extraireFaits("Il fait beau aujourd'hui. La mangue pousse sur un arbre tropical.");
    expect(faits).toHaveLength(0);
  });
});

describe("blocs de code clôturés", () => {
  it("extrait le code avec la ligne explicative qui précède", () => {
    const blocs = extraireBlocsCode(
      "Voici comment mesurer la lumière :\n```python\nlumen = photometre.mesure()\nprint(lumen)\n```\nSuite du texte.",
    );
    expect(blocs).toHaveLength(1);
    expect(blocs[0]?.lang).toBe("python");
    expect(blocs[0]?.code).toContain("photometre.mesure()");
    expect(blocs[0]?.explication).toBe("Voici comment mesurer la lumière :");
  });

  it("ne sort rien sur un bloc jamais clôturé", () => {
    const blocs = extraireBlocsCode("```js\nconst x = 1;\n");
    expect(blocs).toHaveLength(0);
  });
});

describe("extraction complète d'une ressource", () => {
  const RESSOURCE_QA = {
    titre: "Fiche botanique",
    origine: "texte" as const,
    contenu:
      "Q: Qu'est-ce que la photosynthèse ?\nA: Le processus par lequel les plantes vertes transforment la lumière du soleil en énergie chimique, en absorbant le dioxyde de carbone.\n\nQ: Où se déroule la photosynthèse ?\nA: Dans les chloroplastes, les organites verts de la cellule végétale.\n",
  };

  it("extrait les unités Q/A avec empreinte, mots-clés et octets réels", () => {
    const resultat = extraireUnitesConnaissance(RESSOURCE_QA);
    expect(resultat.unites).toHaveLength(2);
    const unite = resultat.unites[0]!;
    expect(unite.type).toBe("qa");
    expect(unite.question).toBe("Qu'est-ce que la photosynthèse ?");
    expect(unite.motscles).toContain("plantes");
    expect(unite.octets).toBeGreaterThan(0);
    expect(unite.empreinte).toMatch(/^[0-9a-f]{16}$/);
    expect(resultat.elements).toBe(2);
    expect(resultat.ignores).toBe(0);
    expect(resultat.octetsTraites).toBeGreaterThan(0);
  });

  it("est déterministe (même ressource → mêmes empreintes)", () => {
    const a = extraireUnitesConnaissance(RESSOURCE_QA);
    const b = extraireUnitesConnaissance(RESSOURCE_QA);
    expect(a.unites.map((u) => u.empreinte)).toEqual(b.unites.map((u) => u.empreinte));
  });

  it("extrait les faits et le code d'un texte narratif", () => {
    const resultat = extraireUnitesConnaissance({
      titre: "Notes d'astronomie",
      origine: "texte",
      contenu:
        "La galaxie d'Andromède est la galaxie spirale la plus proche de la Voie lactée, visible à l'œil nu par nuit noire.\n\nVoici la distance :\n```text\n2,5 millions d'années-lumière\n```\n",
      });
    expect(resultat.unites.some((u) => u.type === "fait" && u.question.includes("Andromède"))).toBe(true);
    expect(resultat.unites.some((u) => u.type === "code" && u.contenu.includes("années-lumière"))).toBe(true);
  });

  it("parse un dataset JSON en unités Q/A (mêmes clés que le moteur gen3-native)", () => {
    const resultat = extraireUnitesConnaissance({
      titre: "cours-botanique.json",
      origine: "dataset",
      contenu: JSON.stringify([
        { question: "Quelle est la plante la plus haute du monde ?", response: "Le séquoia géant (Sequoiadendron giganteum), jusqu'à environ 95 mètres." },
        { instruction: "Cite un conifère d'Europe.", output: "Le pin sylvestre." },
      ]),
    });
    expect(resultat.unites).toHaveLength(2);
    expect(resultat.unites[0]?.type).toBe("qa");
    expect(resultat.unites[0]?.question).toContain("plante la plus haute");
    expect(resultat.unites[1]?.question).toContain("conifère");
  });

  it("compte honnêtement une ressource vide et une ressource inexploitable", () => {
    const vide = extraireUnitesConnaissance({ titre: "vide", origine: "texte", contenu: "   \n  " });
    expect(vide.unites).toHaveLength(0);
    expect(vide.avertissements).toHaveLength(1);

    const bruit = extraireUnitesConnaissance({ titre: "bruit", origine: "texte", contenu: "ok ok ok" });
    expect(bruit.unites).toHaveLength(0);
    expect(bruit.avertissements.some((a) => a.includes("Aucune unité exploitable"))).toBe(true);
  });
});

describe("fusion multi-ressources", () => {
  it("déduplique les unités identiques entre ressources (compteurs réels)", () => {
    const paire = "Q: Question commune aux deux fiches ?\nA: Réponse partagée identique entre les deux ressources.\n";
    const fusion = fusionnerExtractions([
      extraireUnitesConnaissance({ titre: "fiche-1", origine: "texte", contenu: paire }),
      extraireUnitesConnaissance({ titre: "fiche-2", origine: "texte", contenu: paire }),
    ]);
    expect(fusion.unites).toHaveLength(1);
    expect(fusion.doublons).toBe(1);
    expect(fusion.elements).toBe(2);
  });
});
