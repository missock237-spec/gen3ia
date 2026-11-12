import { describe, expect, it } from "vitest";

import {
  DICTIONNAIRE_ABREVIATIONS,
  developperAbreviations,
  detecterAbreviations,
  estMessageAbrege,
} from "./abreviations";

/**
 * ABRÉVIATIONS FR/EN — dictionnaire large, détection par jetons (bornes de
 * mots, casse, ponctuation collée, positions), désambiguïsation contextuelle,
 * développement propre (URLs / e-mails / code inline / unités chiffrées
 * intacts) et performance 10 Ko < 50 ms.
 */

const REGISTRES_VALIDES = new Set([
  "texto",
  "professionnel",
  "technique",
  "medical",
  "international",
  "unite",
  "code",
]);

describe("abreviations-dictionnaire", () => {
  it("contient au moins 400 entrées", () => {
    expect(Object.keys(DICTIONNAIRE_ABREVIATIONS).length).toBeGreaterThanOrEqual(400);
  });

  it("n'utilise que des clés minuscules, des registres valides et des expansions propres", () => {
    for (const [cle, entree] of Object.entries(DICTIONNAIRE_ABREVIATIONS)) {
      expect(cle).toBe(cle.toLowerCase());
      expect(cle.length).toBeGreaterThan(0);
      expect(entree.expansion.trim().length).toBeGreaterThan(0);
      expect(entree.expansion).toBe(entree.expansion.trim());
      expect(REGISTRES_VALIDES.has(entree.registre)).toBe(true);
    }
  });

  it("garantit que chaque entrée ambiguë expose des sens contextuels", () => {
    for (const entree of Object.values(DICTIONNAIRE_ABREVIATIONS)) {
      if (entree.ambigu === true) {
        expect(entree.senses).toBeDefined();
        expect(entree.senses?.length).toBeGreaterThan(0);
        for (const sens of entree.senses ?? []) {
          expect(sens.expansion.length).toBeGreaterThan(0);
          expect(sens.contexteMotsCles.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("couvre les registres demandés (texto, professionnel, technique, médical, international, unités, code)", () => {
    const registres = new Set(Object.values(DICTIONNAIRE_ABREVIATIONS).map((entree) => entree.registre));
    for (const registre of REGISTRES_VALIDES) {
      expect(registres.has(registre)).toBe(true);
    }
  });
});

describe("detecterAbreviations", () => {
  it("détecte les abréviations texto avec positions exactes et ponctuation collée", () => {
    const occurrences = detecterAbreviations("slt, bcp de PV à préparer auj pour le projet JS");
    const cles = occurrences.map((occurrence) => occurrence.abreviation);
    expect(cles).toContain("slt");
    expect(cles).toContain("bcp");
    expect(cles).toContain("pv");
    expect(cles).toContain("auj");
    expect(cles).toContain("js");
    const slt = occurrences.find((occurrence) => occurrence.abreviation === "slt");
    expect(slt?.index).toBe(0);
    expect(slt?.fin).toBe(3);
    expect(slt?.texteBrut).toBe("slt");
    expect(slt?.expansion).toBe("salut");
  });

  it("est insensible à la casse (SLT, Slt, slt)", () => {
    for (const casse of ["SLT !!!", "Slt ?", "slt,"]) {
      const occurrences = detecterAbreviations(casse);
      expect(occurrences.length).toBe(1);
      expect(occurrences[0]?.abreviation).toBe("slt");
      expect(occurrences[0]?.expansion).toBe("salut");
    }
  });

  it("respecte les bornes de mots (xslt n'est pas slt)", () => {
    expect(detecterAbreviations("j'adore le xslt")).toHaveLength(0);
  });

  it("marque les ambiguïtés et les zones protégées", () => {
    const occurrences = detecterAbreviations("un cd sans contexte");
    const cd = occurrences.find((occurrence) => occurrence.abreviation === "cd");
    expect(cd?.ambigu).toBe(true);
    expect(cd?.expansion).toBeNull();

    const js = detecterAbreviations("vois https://exemple.com/js").find(
      (occurrence) => occurrence.abreviation === "js",
    );
    expect(js?.abreviation).toBe("js");
    expect(js?.protege).toBe(true);
    expect(js?.expansion).toBeNull();
  });
});

describe("developperAbreviations", () => {
  it("développe proprement une demande texto + acronymes", () => {
    const developpe = developperAbreviations("slt, bcp de PV à préparer auj pour le projet JS");
    expect(developpe).toContain("salut,");
    expect(developpe).toContain("beaucoup de procès-verbal");
    expect(developpe).toContain("aujourd'hui");
    expect(developpe).toContain("le projet JavaScript");
    expect(developpe).not.toMatch(/\b(slt|bcp|auj)\b/);
  });

  it("désambiguïse TT par le contexte (tout vs toujours)", () => {
    expect(developperAbreviations("tt le monde est là")).toContain("tout le monde");
    expect(developperAbreviations("il est tt en retard")).toContain("toujours en retard");
  });

  it("désambiguïse DC (donc / DC Comics / décédé)", () => {
    expect(developperAbreviations("dc je vais y aller")).toContain("donc je vais");
    expect(developperAbreviations("un film DC avec batman")).toContain("DC Comics");
    expect(developperAbreviations("et dc ?")).toBe("et dc ?");
  });

  it("désambiguïse PC (ordinateur vs pourquoi) et PR (pour vs pull request)", () => {
    expect(developperAbreviations("pc tu rentres ?")).toContain("pourquoi tu rentres");
    expect(developperAbreviations("j'ai acheté un pc gamer")).toContain("ordinateur personnel");
    expect(developperAbreviations("pr le projet")).toContain("pour le projet");
    expect(developperAbreviations("la pr sur github")).toContain("pull request");
  });

  it("désambiguïse CD (disque compact vs déploiement continu)", () => {
    expect(developperAbreviations("il a gravé un cd")).toContain("disque compact");
    expect(developperAbreviations("le cd tourne dans la pipeline")).toContain("déploiement continu");
  });

  it("laisse intactes les ambiguïtés sans contexte valide", () => {
    expect(developperAbreviations("un pc, un pr et un cd")).toBe("un pc, un pr et un cd");
  });

  it("préserve l'élision lors du développement (l'ia → l'intelligence artificielle)", () => {
    expect(developperAbreviations("l'ia répond vite")).toBe(
      "l'intelligence artificielle répond vite",
    );
  });

  it("n'expansionne JAMAIS dans les URLs, e-mails et code inline", () => {
    expect(developperAbreviations("regarde https://exemple.com/js et dis-moi")).toBe(
      "regarde https://exemple.com/js et dis-moi",
    );
    expect(developperAbreviations("écris à jean.js@exemple.fr bcp")).toContain("jean.js@exemple.fr beaucoup");
    expect(developperAbreviations("lance `npm run dev` stp")).toBe("lance `npm run dev` s'il te plaît");
  });

  it("n'expansionne JAMAIS les unités collées à un chiffre", () => {
    expect(developperAbreviations("j'ai marché 5 km")).toBe("j'ai marché 5 km");
    expect(developperAbreviations("doser 500 mg deux fois")).toBe("doser 500 mg deux fois");
    expect(developperAbreviations("il fait 20 °C aujourd'hui")).toBe("il fait 20 °C aujourd'hui");
    expect(developperAbreviations("une partie à 60 fps")).toBe("une partie à 60 fps");
  });

  it("développe les unités et abréviations hors contexte chiffré", () => {
    expect(developperAbreviations("au strict min")).toContain("minimum");
    expect(developperAbreviations("attends une min environ")).toContain("minute");
    expect(developperAbreviations("ce fichier va au max")).toContain("maximum");
  });

  it("n'expansionne pas les faux positifs (etc., mots normaux, tokens imbriqués)", () => {
    const texte = "Salut, bonjour, toujours et pourquoi etc. puis xslt.";
    expect(developperAbreviations(texte)).toBe(texte);
  });

  it("conserve l'abréviation d'origine si demandé", () => {
    expect(developperAbreviations("slt", { conserverOriginale: true })).toBe("salut (slt)");
    expect(developperAbreviations("bcp de PV auj", { conserverOriginale: true })).toContain(
      "procès-verbal (PV)",
    );
  });

  it("respecte une fenêtre de contexte personnalisée", () => {
    const texte = "tt au debut du message tres loin d'ici retard";
    expect(developperAbreviations(texte, { fenetreContexte: 2 })).toBe(texte);
    expect(developperAbreviations(texte, { fenetreContexte: 8 })).toContain("toujours");
  });
});

describe("estMessageAbrege", () => {
  it("signale un message texto abrégé", () => {
    expect(estMessageAbrege("slt c'est bon")).toBe(true);
    expect(estMessageAbrege("rdv demain stp")).toBe(true);
  });

  it("ne signale pas une phrase normale, une URL seule ou un message ambigu non tranché", () => {
    expect(estMessageAbrege("Bonjour, pouvez-vous m'aider sur ce point ?")).toBe(false);
    expect(estMessageAbrege("vois https://exemple.com/js")).toBe(false);
    expect(estMessageAbrege("un pc, un pr et un cd")).toBe(false);
  });
});

describe("performance", () => {
  it("développe un texte de 10 Ko en moins de 50 ms (Map O(1), passage unique)", () => {
    const paragraphe = "slt, je te propose un rdv demain avec le dev pour parler du js du projet. ";
    const texte = (paragraphe + "bcp de PV à préparer auj, merci d'avance. ").repeat(90);
    expect(texte.length).toBeGreaterThanOrEqual(10_000);

    const debut = performance.now();
    const resultat = developperAbreviations(texte);
    const duree = performance.now() - debut;

    expect(resultat.length).toBeGreaterThan(texte.length);
    expect(resultat).toContain("salut,");
    expect(resultat).toContain("rendez-vous");
    expect(duree).toBeLessThan(50);
  });
});
