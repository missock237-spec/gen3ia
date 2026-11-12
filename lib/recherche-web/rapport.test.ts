import { describe, expect, it } from "vitest";

import { construirRapportRecherche, evaluerFiabilite } from "./rapport";

/* ------------------------------------------------------------------ */
/* Fixtures — résultats hétérogènes (comme une vraie recherche)         */
/* ------------------------------------------------------------------ */

const RESULTATS_HETEROGENES = [
  {
    titre: "Le marché de l'intelligence artificielle dépasse 300 milliards de dollars",
    extrait:
      "Le marché de l'IA progresse de 37 % en 2026, porté par la demande des entreprises. Les investissements atteignent un niveau record.",
    publieLe: "2026-11-10",
  },
  {
    titre: "Régulation : l'Europe durcit son cadre sur l'intelligence artificielle",
    extrait:
      "La loi européenne impose de nouvelles obligations aux fournisseurs de modèles d'intelligence artificielle dès janvier 2027. Les sanctions peuvent atteindre 35 millions d'euros.",
  },
  {
    titre: "Bitcoin : la crypto repasse au-dessus de 100 000 dollars",
    extrait: "Le cours du Bitcoin gagne 2,4 % ce matin dans un contexte de reprise, mais certains analystes restent prudents.",
  },
  {
    titre: "Ligue 1 : le PSG s'impose 3-1 et prend la tête du classement",
    extrait:
      "Au classement de la Ligue 1, le club parisien compte désormais 5 points d'avance après sa victoire du week-end.",
  },
  {
    titre: "Météo : vague de froid attendue sur la France cette semaine",
    extrait: "Les températures chuteront jusqu'à -8 °C en montagne dès jeudi selon les prévisionnistes.",
  },
];

/** Un résultat « pollué » : URL, domaine et courriel dans le titre/extrait
 *  — exactement ce que le rapport ne doit JAMAIS relayer. */
const RESULTAT_AVEC_ADRESSES = {
  titre: "Analyse complète sur exemple.fr | ActuMarché",
  extrait:
    "Retrouvez l'article complet sur https://exemple.fr/analyse-marche et la newsletter contact@actumarche.fr. Le marché pèse 300 milliards de dollars en 2026.",
};

const REGEX_URL = /https?:\/\//i;
const REGEX_WWW = /www\./i;
const REGEX_DOMAINE = /\b[a-z0-9][a-z0-9._-]*\.(?:com|fr|org|net|io|dev|ai|eu|co)\b/i;
const REGEX_MENTION_SOURCES = /\bsources?\b/i;
const REGEX_MOTEURS = /duckduckgo|bing|searxng|wikipedia|tavily|serper/i;

/** Assertions de NON-FUITE, réutilisées par plusieurs tests. */
function expectSansFuite(rapportTexte: string): void {
  expect(rapportTexte).not.toMatch(REGEX_URL);
  expect(rapportTexte).not.toMatch(REGEX_WWW);
  expect(rapportTexte).not.toMatch(REGEX_DOMAINE);
  expect(rapportTexte).not.toMatch(REGEX_MENTION_SOURCES);
  expect(rapportTexte).not.toMatch(REGEX_MOTEURS);
}

describe("rapport de recherche — construction déterministe", () => {
  it("produit un rapport structuré : titre, sections thématiques, points clés, synthèse", () => {
    const rapport = construirRapportRecherche(
      "marché de l'intelligence artificielle 2026",
      [...RESULTATS_HETEROGENES, RESULTAT_AVEC_ADRESSES],
    );
    expect(rapport.titre).toContain("Rapport de recherche");
    expect(rapport.texte).toContain("Thème 1");
    expect(rapport.texte).toContain("Points clés");
    expect(rapport.texte).toContain("Synthèse");
    expect(rapport.texte.length).toBeGreaterThan(600);
  });

  it("AUCUNE URL, AUCUN domaine, AUCUNE mention de sources (assertions regex négatives)", () => {
    const rapport = construirRapportRecherche(
      "comparatif prix voitures électriques",
      [
        { titre: "Prix des voitures électriques en 2026", extrait: "Le prix moyen baisse de 12 % sur un an." },
        { titre: "Batterie : autonomie record", extrait: "Les nouvelles batteries dépassent 600 km." },
        RESULTAT_AVEC_ADRESSES,
      ],
    );
    expectSansFuite(rapport.texte);
  });

  it("l'URL, le domaine et le courriel glissés dans un résultat sont neutralisés", () => {
    const rapport = construirRapportRecherche("marché de l'intelligence artificielle 2026", [
      ...RESULTATS_HETEROGENES,
      RESULTAT_AVEC_ADRESSES,
    ]);
    expect(rapport.texte).not.toContain("exemple.fr");
    expect(rapport.texte).not.toContain("actumarche.fr");
    expect(rapport.texte).not.toContain("https");
    expectSansFuite(rapport.texte);
  });

  it("une requête contenant une URL est nettoyée elle aussi", () => {
    const rapport = construirRapportRecherche("analyse https://exemple.fr/article du marché", [
      { titre: "Le marché ralentit", extrait: "La croissance du marché marque une pause au troisième trimestre." },
    ]);
    expectSansFuite(rapport.texte);
  });

  it("des résultats hétérogènes donnent PLUSIEURS sections thématiques", () => {
    const rapport = construirRapportRecherche(
      "actualités de la semaine",
      RESULTATS_HETEROGENES,
    );
    expect(rapport.sections).toBeGreaterThanOrEqual(3);
    expect(rapport.texte).toContain("Thème 1");
    expect(rapport.texte).toContain("Thème 2");
    expect(rapport.texte).toContain("Thème 3");
  });

  it("des résultats du MÊME sujet restent groupés (une section, pas du saupoudrage)", () => {
    const rapport = construirRapportRecherche("véhicules électriques", [
      { titre: "Véhicules électriques : les ventes progressent en Europe", extrait: "Les ventes de véhicules électriques gagnent 18 % sur un an en Europe." },
      { titre: "Batterie des véhicules électriques : autonomie record", extrait: "L'autonomie des batteries des véhicules électriques dépasse 600 km." },
      { titre: "Véhicules électriques d'occasion : prix en baisse", extrait: "Le prix des véhicules électriques d'occasion recule de 9 % en Europe." },
    ]);
    expect(rapport.sections).toBe(1);
    expect(rapport.texte).toContain("Thème 1");
  });

  it("les chiffres, dates et acteurs des extraits nourrissent les points clés", () => {
    const rapport = construirRapportRecherche(
      "marché de l'intelligence artificielle 2026",
      [...RESULTATS_HETEROGENES, RESULTAT_AVEC_ADRESSES],
    );
    expect(rapport.texte).toContain("37 %");
    expect(rapport.texte).toContain("35 millions");
  });

  it("les désaccords entre contenus déclenchent la section nuances", () => {
    const rapport = construirRapportRecherche("croissance du marché", [
      { titre: "Le marché croît vite", extrait: "Le marché croît de 18 % par an selon l'étude publiée en janvier 2026." },
      {
        titre: "Des estimations divergentes",
        extrait: "En revanche, d'autres estimations du marché avancent une croissance de 34 % annuellement.",
      },
      {
        titre: "Des chercheurs contestent les chiffres",
        extrait: "Cependant, des chercheurs contestent la méthodologie de ces mesures du marché.",
      },
    ]);
    expect(rapport.texte).toContain("Nuances");
    expect(rapport.texte).toContain("valeurs différentes circulent");
  });

  it("pas de désaccord détecté → la section nuances est omise (pas de remplissage)", () => {
    const rapport = construirRapportRecherche("véhicules électriques", [
      { titre: "Véhicules électriques : les ventes progressent", extrait: "Les ventes de véhicules électriques gagnent 18 % sur un an." },
      { titre: "Batteries : autonomie record", extrait: "L'autonomie des batteries dépasse 600 km en Europe." },
    ]);
    expect(rapport.texte).not.toContain("Nuances");
  });

  it("cas 0 résultat : échec honnête clair (rien n'est inventé)", () => {
    const rapport = construirRapportRecherche("sujet introuvable", []);
    expect(rapport.sections).toBe(0);
    expect(rapport.fiabilite).toBe("basse");
    expect(rapport.texte).toContain("Aucun contenu exploitable");
    expect(rapport.texte).toContain("fiabilité basse");
    expectSansFuite(rapport.texte);
  });

  it("cas résultats sans contenu utile : échec honnête identique", () => {
    const rapport = construirRapportRecherche("sujet vide", [
      { titre: "", extrait: "" },
      { titre: "   ", extrait: undefined },
    ]);
    expect(rapport.sections).toBe(0);
    expect(rapport.fiabilite).toBe("basse");
    expect(rapport.texte).toContain("Aucun contenu exploitable");
  });

  it("la synthèse est actionnable et dit sa limite (extraits, pas de lecture intégrale)", () => {
    const rapport = construirRapportRecherche(
      "marché de l'intelligence artificielle 2026",
      [...RESULTATS_HETEROGENES, RESULTAT_AVEC_ADRESSES],
    );
    expect(rapport.texte).toContain("Pour aller plus loin");
    expect(rapport.texte).toContain("extraits recueillis");
    expect(rapport.texte).toContain("n'ont pas été lues intégralement");
  });

  it("la fiabilité suit le volume recueilli (basse / moyenne / haute)", () => {
    expect(evaluerFiabilite(0)).toBe("basse");
    expect(evaluerFiabilite(2)).toBe("basse");
    expect(evaluerFiabilite(4)).toBe("moyenne");
    expect(evaluerFiabilite(7)).toBe("haute");
    const petit = construirRapportRecherche("sujet", RESULTATS_HETEROGENES.slice(0, 2));
    expect(petit.fiabilite).toBe("basse");
    const gros = construirRapportRecherche("sujet", [...RESULTATS_HETEROGENES, RESULTAT_AVEC_ADRESSES]);
    expect(gros.fiabilite).toBe("haute");
  });
});
