import { describe, expect, it } from "vitest";

import { choisirDatasets, REQUETES_OBJECTIF, requeteDuCycle, type RechercheObjectif } from "./catalogue";

/* ------------------------------------------------------------------ */
/* LE CONSERVATEUR — sélection déterministe, anti-rejoue, équilibre     */
/* ------------------------------------------------------------------ */

function recherche(
  objectif: "langage" | "intention",
  refs: Array<[string, number]>,
  provider: "huggingface" | "kaggle" = "huggingface",
): RechercheObjectif {
  return {
    objectif,
    provider,
    requete: REQUETES_OBJECTIF[objectif][provider][0],
    resultats: refs.map(([ref, downloads]) => ({ ref, titre: ref, downloads, taille: null })),
  };
}

describe("choisirDatasets", () => {
  it("trie par téléchargements décroissants (déterministe)", () => {
    const choisis = choisirDatasets(
      [recherche("langage", [["a/populaire", 5000], ["b/connu", 9000], ["c/confidentiel", 12]])],
      [],
      { maxDatasetsParCycle: 5, maxParObjectif: 3 },
    );
    expect(choisis.map((c) => c.ref)).toEqual(["b/connu", "a/populaire", "c/confidentiel"]);
  });

  it("écarte les datasets déjà ingérés (anti-rejoue)", () => {
    const choisis = choisirDatasets(
      [recherche("langage", [["deja/vu", 9000], ["nouveau/donnee", 100]])],
      ["Deja/Vu"],
      { maxDatasetsParCycle: 5, maxParObjectif: 3 },
    );
    expect(choisis.map((c) => c.ref)).toEqual(["nouveau/donnee"]);
  });

  it("dédoublonne entre requêtes d'un même objectif", () => {
    const choisis = choisirDatasets(
      [
        recherche("langage", [["dup/ref", 9000]]),
        recherche("langage", [["dup/ref", 9000], ["autre/ref", 100]]),
      ],
      [],
      { maxDatasetsParCycle: 5, maxParObjectif: 3 },
    );
    expect(choisis.map((c) => c.ref)).toEqual(["dup/ref", "autre/ref"]);
  });

  it("respecte les plafonds globaux et par objectif (équilibre)", () => {
    const choisis = choisirDatasets(
      [
        recherche("langage", [["l/1", 9], ["l/2", 8], ["l/3", 7]]),
        recherche("intention", [["i/1", 9], ["i/2", 8], ["i/3", 7]]),
      ],
      [],
      { maxDatasetsParCycle: 3, maxParObjectif: 2 },
    );
    // Rotation langage → intention : 2 langage max, puis 1 intention.
    expect(choisis.map((c) => c.ref)).toEqual(["l/1", "i/1", "l/2"]);
  });

  it("ne retient rien quand tous les candidats sont déjà ingérés", () => {
    const choisis = choisirDatasets(
      [recherche("intention", [["i/1", 9]])],
      ["i/1"],
      { maxDatasetsParCycle: 4, maxParObjectif: 2 },
    );
    expect(choisis).toEqual([]);
  });
});

describe("requeteDuCycle", () => {
  it("fait tourner les requêtes du catalogue selon le numéro de cycle", () => {
    const requetes = REQUETES_OBJECTIF.langage.huggingface;
    expect(requeteDuCycle("langage", "huggingface", 0)).toBe(requetes[0]);
    expect(requeteDuCycle("langage", "huggingface", 1)).toBe(requetes[1]);
    // Modulo : au-delà du catalogue, retour à la première requête.
    expect(requeteDuCycle("langage", "huggingface", requetes.length)).toBe(requetes[0]);
  });
});

describe("REQUETES_OBJECTIF", () => {
  it("toutes les requêtes respectent le contrat assertHubQuery (1..80 caractères)", () => {
    for (const objectif of ["langage", "intention"] as const) {
      for (const hub of ["huggingface", "kaggle"] as const) {
        for (const requete of REQUETES_OBJECTIF[objectif][hub]) {
          expect(requete.trim()).toBe(requete);
          expect(requete.length).toBeGreaterThan(0);
          expect(requete.length).toBeLessThanOrEqual(80);
        }
      }
    }
  });

  it("élargissement des domaines vides : requêtes à évidence HF présentes", () => {
    // Mêmes requêtes validées par extraction de matière réelle que le
    // catalogue de maîtrise (sciences, culture-histoire, langues, sujets).
    expect(REQUETES_OBJECTIF.langage.huggingface).toEqual(
      expect.arrayContaining(["medical meadow", "physics qa", "history qa", "translation instructions", "french translation"]),
    );
    expect(REQUETES_OBJECTIF.intention.huggingface).toEqual(
      expect.arrayContaining(["news classification dataset", "text classification"]),
    );
  });

  it("aucun doublon dans une même liste objectif/hub", () => {
    for (const objectif of ["langage", "intention"] as const) {
      for (const hub of ["huggingface", "kaggle"] as const) {
        const requetes = REQUETES_OBJECTIF[objectif][hub];
        expect(new Set(requetes.map((r) => r.toLowerCase())).size).toBe(requetes.length);
      }
    }
  });
});
