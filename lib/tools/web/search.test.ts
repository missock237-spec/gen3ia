import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiagnosticRecherche, ResultatVerifie } from "@/lib/recherche-web/types";

// L'agrégateur multi-moteurs est MOCKÉ : on teste le CONTRAT du tool
// (rapport utilisateur, fiabilité, champ interne), pas le réseau.
vi.mock("@/lib/recherche-web/moteurs/agregateur", () => ({
  agregerMoteurs: vi.fn(),
}));

import { agregerMoteurs } from "@/lib/recherche-web/moteurs/agregateur";
import { searchWeb, webSearchTool } from "./search";

const agregerMoteursMock = vi.mocked(agregerMoteurs);

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

function resultatVerifie(titre: string, url: string, extrait: string, date?: string): ResultatVerifie {
  return {
    titre,
    url,
    extrait,
    ...(date ? { publieLe: date } : {}),
    moteur: "duckduckgo",
    confirmations: 1,
    urlCanonique: url,
    credibilite: "moyenne",
    score: 12,
  };
}

function diagnostic(nb: number): DiagnosticRecherche {
  return {
    moteursInterroges: ["duckduckgo", "bing"],
    moteursOperatifs: ["duckduckgo", "bing"],
    moteursEnEchec: [],
    resultatsBruts: nb,
    resultatsUniques: nb,
    doublonsRetires: 0,
  };
}

const URLS_FIXTURES = [
  "https://exemple-actu.com/ia-marche-2026",
  "https://exemple-regulation.eu/cadre-ia",
  "https://exemple-crypto.com/bitcoin",
  "https://exemple-sport.fr/ligue-1",
  "https://exemple-meteo.org/vague-froid",
  "https://exemple-tech.io/investissements",
];

const RESULTATS_HETEROGENES: ResultatVerifie[] = [
  resultatVerifie(
    "Le marché de l'intelligence artificielle dépasse 300 milliards de dollars",
    URLS_FIXTURES[0],
    "Le marché de l'IA progresse de 37 % en 2026, porté par la demande des entreprises.",
    "2026-11-10",
  ),
  resultatVerifie(
    "Régulation : l'Europe durcit son cadre sur l'intelligence artificielle",
    URLS_FIXTURES[1],
    "La loi européenne impose de nouvelles obligations aux fournisseurs de modèles d'IA dès 2027.",
  ),
  resultatVerifie(
    "Bitcoin : la crypto repasse au-dessus de 100 000 dollars",
    URLS_FIXTURES[2],
    "Le cours du Bitcoin gagne 2,4 % ce matin dans un contexte de reprise, mais certains analystes restent prudents.",
  ),
  resultatVerifie(
    "Ligue 1 : le PSG s'impose et prend la tête du classement",
    URLS_FIXTURES[3],
    "Au classement de la Ligue 1, le club parisien compte 5 points d'avance après sa victoire.",
  ),
  resultatVerifie(
    "Météo : vague de froid attendue sur la France cette semaine",
    URLS_FIXTURES[4],
    "Les températures chuteront jusqu'à -8 °C en montagne dès jeudi.",
  ),
  resultatVerifie(
    "Investissements record dans la tech cette année",
    URLS_FIXTURES[5],
    "Les investissements dans les jeunes pousses atteignent 40 milliards de dollars.",
  ),
];

/** Un moteur entier en échec : le diagnostic doit le DIRE honnêtement. */
const DIAGNOSTIC_PARTIEL: DiagnosticRecherche = {
  ...diagnostic(RESULTATS_HETEROGENES.length),
  moteursOperatifs: ["duckduckgo"],
  moteursEnEchec: [{ moteur: "bing", raison: "challenge anti-robot" }],
  resultatsBruts: 4,
  resultatsUniques: 4,
};

beforeEach(() => {
  // La cascade doit viser l'agrégateur mocké : aucun provider cléé.
  delete process.env.SEARCH_PROVIDER;
  delete process.env.SEARCH_API_KEY;
  agregerMoteursMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tool web.search — sortie UTILISATEUR = rapport sans sources", () => {
  it("livre { rapport, sections, fiabilité, diagnostic } et garde les résultats bruts en interne", async () => {
    agregerMoteursMock.mockResolvedValue({
      resultats: RESULTATS_HETEROGENES,
      diagnostic: diagnostic(RESULTATS_HETEROGENES.length),
    });

    const sortie = await webSearchTool.execute({
      query: "marché de l'intelligence artificielle 2026",
      maxResults: 6,
    });

    // Contrat utilisateur : un rapport autonome, structuré, chiffré.
    expect(typeof sortie.rapport).toBe("string");
    expect(sortie.rapport.length).toBeGreaterThan(400);
    expect(sortie.sections).toBeGreaterThan(0);
    expect(sortie.fiabilite).toBe("haute"); // 6 résultats recueillis
    expect(sortie.rapport).toContain("Points clés");
    expect(sortie.rapport).toContain("Synthèse");
    expect(sortie.rapport).not.toMatch(/\bsources?\b/i);

    // Diagnostic honnête conservé tel quel.
    expect(sortie.diagnostic?.moteursOperatifs).toEqual(["duckduckgo", "bing"]);
    expect(sortie.diagnostic?.doublonsRetires).toBe(0);

    // Champ interne : résultats bruts complets (le moteur en a besoin).
    expect(sortie.__interne.resultats).toHaveLength(6);
    expect(sortie.__interne.resultats[0].url).toBe(URLS_FIXTURES[0]);

    // Sérialisation publique (timeline, SSE, persistance) : AUCUNE URL.
    const serialise = JSON.stringify(sortie);
    for (const url of URLS_FIXTURES) expect(serialise).not.toContain(url);
    expect(serialise).not.toMatch(/https?:\/\//);
    expect(serialise).toContain("RAPPORT DE RECHERCHE");
    expect(serialise).toContain("fiabilité");
  });

  it("la fiabilité suit le nombre de résultats (2 basse, 4 moyenne, 7 haute)", async () => {
    const executer = async (resultats: ResultatVerifie[]) => {
      agregerMoteursMock.mockReset();
      agregerMoteursMock.mockResolvedValue({ resultats, diagnostic: diagnostic(resultats.length) });
      return webSearchTool.execute({ query: "sujet de test", maxResults: resultats.length });
    };

    const deux = await executer(RESULTATS_HETEROGENES.slice(0, 2));
    expect(deux.fiabilite).toBe("basse");

    const quatre = await executer(RESULTATS_HETEROGENES.slice(0, 4));
    expect(quatre.fiabilite).toBe("moyenne");

    const sept = await executer([
      ...RESULTATS_HETEROGENES,
      resultatVerifie("Complément un", "https://exemple-un.com/a", "Un complément utile sur le sujet du test."),
      resultatVerifie("Complément deux", "https://exemple-deux.com/b", "Autre complément utile sur le même sujet."),
    ]);
    expect(sept.fiabilite).toBe("haute");
  });

  it("des résultats hétérogènes produisent PLUSIEURS sections dans le rapport", async () => {
    agregerMoteursMock.mockResolvedValue({
      resultats: RESULTATS_HETEROGENES,
      diagnostic: diagnostic(RESULTATS_HETEROGENES.length),
    });

    const sortie = await webSearchTool.execute({
      query: "actualités de la semaine",
      maxResults: 6,
    });

    expect(sortie.sections).toBeGreaterThanOrEqual(3);
    expect(sortie.rapport).toContain("Thème 1");
    expect(sortie.rapport).toContain("Thème 2");
    expect(sortie.rapport).toContain("Thème 3");
    expect(sortie.rapport).toContain("Nuances");
  });

  it("l'échec de moteur est DIT dans le diagnostic (honnêteté conservée)", async () => {
    agregerMoteursMock.mockResolvedValue({
      resultats: RESULTATS_HETEROGENES,
      diagnostic: DIAGNOSTIC_PARTIEL,
    });

    const sortie = await webSearchTool.execute({ query: "sujet", maxResults: 6 });

    expect(sortie.diagnostic?.moteursOperatifs).toEqual(["duckduckgo"]);
    expect(sortie.diagnostic?.moteursEnEchec).toEqual([{ moteur: "bing", raison: "challenge anti-robot" }]);
    // Le rapport, lui, reste centré sur la matière — pas sur les moteurs.
    expect(sortie.rapport).not.toMatch(/duckduckgo|bing|searxng/i);
  });

  it("cas 0 résultat (cascade entière à sec) : échec honnête et explicite", async () => {
    agregerMoteursMock.mockResolvedValue({
      resultats: [],
      diagnostic: {
        moteursInterroges: ["duckduckgo", "bing"],
        moteursOperatifs: [],
        moteursEnEchec: [
          { moteur: "duckduckgo", raison: "challenge anti-robot" },
          { moteur: "bing", raison: "fetch failed" },
        ],
        resultatsBruts: 0,
        resultatsUniques: 0,
        doublonsRetires: 0,
      },
    });
    // Le repli Wikipédia est le dernier maillon : sans réseau, la cascade
    // s'arrête et l'outil dit clairement l'échec (rien n'est inventé).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("réseau coupé (test)");
      }),
    );

    await expect(
      webSearchTool.execute({ query: "sujet introuvable", maxResults: 5 }),
    ).rejects.toThrow("Aucune source de recherche disponible.");
  });

  it("repli Wikipédia : la cascade finale produit aussi un rapport autonome", async () => {
    agregerMoteursMock.mockRejectedValue(new Error("agrégateur indisponible"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (entree: string | URL) => {
        const url = String(entree);
        if (url.includes("wikipedia.org")) {
          return new Response(
            JSON.stringify({
              query: {
                search: [
                  {
                    title: "Intelligence artificielle",
                    snippet: "L'intelligence artificielle est un domaine de l'informatique depuis 1956.",
                    timestamp: "2026-11-01T10:00:00Z",
                  },
                ],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`hôte inattendu : ${url}`);
      }),
    );

    const sortie = await webSearchTool.execute({ query: "intelligence artificielle", maxResults: 5 });

    expect(sortie.__interne.resultats[0].source).toBe("Wikipédia (fr)");
    expect(sortie.fiabilite).toBe("basse"); // 1 seul résultat recueilli
    expect(sortie.rapport).toContain("RAPPORT DE RECHERCHE");
    expect(sortie.rapport).toContain("Synthèse");
    const serialise = JSON.stringify(sortie);
    expect(serialise).not.toContain("wikipedia.org/wiki");
    expect(serialise).not.toMatch(/https?:\/\//);
  });

  it("le helper interne searchWeb() livre toujours les résultats BRUTS (usage moteur)", async () => {
    agregerMoteursMock.mockResolvedValue({
      resultats: RESULTATS_HETEROGENES.slice(0, 3),
      diagnostic: diagnostic(3),
    });

    const bruts = await searchWeb("sujet interne", 3);
    expect(bruts).toHaveLength(3);
    expect(bruts[0].url).toBe(URLS_FIXTURES[0]);
    expect(bruts[0].title).toBeDefined();
  });
});
