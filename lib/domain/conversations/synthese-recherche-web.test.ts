import { describe, expect, it } from "vitest";

import { composerDepuisConnaissances } from "@/lib/neural/connaissances-pont";
import {
  blocContexteDepuisSortieRecherche,
  parserSortieRechercheWeb,
} from "./synthese-recherche-web";

/** Sortie RÉELLE typique de l'outil web.search (SearchResponse). */
const SORTIE_REELLE = {
  results: [
    {
      title: "L'actualité de l'intelligence artificielle en novembre 2026",
      url: "https://exemple-actu.com/ia-novembre-2026",
      snippet:
        "Le marché de l'intelligence artificielle connaît une accélération notable cette semaine.",
      publishedAt: "2026-11-10",
      source: "Bing",
    },
    {
      title: "Cours du Bitcoin : la crypto repart à la hausse",
      url: "https://exemple-crypto.com/cours",
      snippet: "Le prix du Bitcoin évolue de 2,4 % depuis ce matin.",
      source: "Bing",
    },
  ],
  diagnostic: {
    moteursOperatifs: ["bing"],
    moteursEnEchec: [{ moteur: "duckduckgo", raison: "fetch failed" }],
    doublonsRetires: 1,
  },
};

describe("synthèse recherche web — sortie outil → bloc pont", () => {
  it("la sortie JSON de web.search devient un bloc au format du pont", () => {
    const bloc = blocContexteDepuisSortieRecherche(SORTIE_REELLE);
    expect(bloc).toContain("[RECHERCHE WEB TEMPS RÉEL gen3ia");
    expect(bloc).toContain("[1] L'actualité de l'intelligence artificielle");
    expect(bloc).toContain("URL : https://exemple-actu.com/ia-novembre-2026");
    expect(bloc).toContain("Extrait :");
    expect(bloc).toContain("[2] Cours du Bitcoin");
  });

  it("une chaîne JSON (sortie condensée) est aussi acceptée", () => {
    const bloc = blocContexteDepuisSortieRecherche(JSON.stringify(SORTIE_REELLE));
    expect(bloc).toContain("[1] L'actualité de l'intelligence artificielle");
  });

  it("aucun résultat réel → bloc VIDE (aucune source prétendue)", () => {
    expect(blocContexteDepuisSortieRecherche({ results: [] })).toBe("");
    expect(blocContexteDepuisSortieRecherche(null)).toBe("");
    expect(blocContexteDepuisSortieRecherche("pas du json")).toBe("");
    expect(blocContexteDepuisSortieRecherche(undefined)).toBe("");
  });

  it("les résultats sans titre ou sans URL sont ignorés, pas inventés", () => {
    const bloc = blocContexteDepuisSortieRecherche({
      results: [
        { title: "Sans URL" },
        { url: "https://sans-titre.com" },
        { title: "Complet", url: "https://complet.com", snippet: "Extrait réel." },
      ],
    });
    expect(bloc).toContain("[1] Complet");
    expect(bloc).not.toContain("Sans URL");
    expect(bloc).not.toContain("sans-titre.com");
  });

  it("bout en bout : le pont CITE les sources du bloc avec leur URL", () => {
    const bloc = blocContexteDepuisSortieRecherche(SORTIE_REELLE);
    const composition = composerDepuisConnaissances(
      "Cherche sur le web les dernières actualités intelligence artificielle",
      bloc,
    );
    expect(composition).not.toBeNull();
    expect(composition!.texte).toContain("recherche web temps réel gen3ia");
    expect(composition!.texte).toContain("https://exemple-actu.com/ia-novembre-2026");
    expect(composition!.texte).toContain("— Source web :");
  });

  it("parserSortieRechercheWeb rejette les formes non conformes", () => {
    expect(parserSortieRechercheWeb({ pasDeResults: true })).toBeNull();
    expect(parserSortieRechercheWeb(42)).toBeNull();
    expect(parserSortieRechercheWeb("[1,2,3]")).toBeNull();
    expect(parserSortieRechercheWeb(SORTIE_REELLE)).not.toBeNull();
  });
});
