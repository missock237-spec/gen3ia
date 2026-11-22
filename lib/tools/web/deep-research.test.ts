import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WEB DEEP RESEARCH (demande produit 2026-11-22) — contrats verrouillés :
 *  1. PLANCHER ABSOLU : au moins 10 pages réellement ouvertes quand les
 *     candidats le permettent (toute difficulté) ;
 *  2. diversité des sources : maximum 3 pages par domaine ;
 *  3. dédup des URLs identiques entre requêtes différenciées ;
 *  4. fail-soft : les pages en échec sont listées honnêtement, la recherche
 *     continue avec les autres ;
 *  5. budget temps : la recherche s'arrête proprement à deadline, le
 *     résultat porte la note honnête (pages lues / pages exigées).
 */

vi.mock("@/lib/security/url-safety", () => ({
  assertPublicHttpUrl: vi.fn(async (value: string) => value),
}));

const searchWebMock = vi.fn();
vi.mock("./search", () => ({
  searchWeb: (...args: unknown[]) => searchWebMock(...(args as [])),
}));

import { executeDeepResearch } from "./deep-research";

const OBJECTIF_SIMPLE = "crée un site e-commerce pour vendre du café en grains";

/** Construit N URLs réparties sur D domaines (domaine{i % d}.exemple.com). */
function urlsPour(n: number, d: number): Array<{ title: string; url: string }> {
  return Array.from({ length: n }, (_valeur, index) => ({
    title: `Résultat ${index + 1}`,
    url: `https://domaine${index % d}.exemple.com/page-${index + 1}`,
  }));
}

let fetchImplMock: typeof fetch;

beforeEach(() => {
  searchWebMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("executeDeepResearch", () => {
  it("ouvre au moins 10 pages réelles pour une demande simple (plancher absolu)", async () => {
    searchWebMock.mockResolvedValue(urlsPour(30, 6));
    fetchImplMock = vi.fn(async () =>
      new Response("<html><body><p>Contenu réel de la page pour la recherche approfondie Gen3.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchImplMock);

    const resultat = await executeDeepResearch({ objective: OBJECTIF_SIMPLE });
    expect(resultat.pagesRequises).toBeGreaterThanOrEqual(10);
    expect(resultat.pagesOuvertes).toBeGreaterThanOrEqual(10);
    expect(resultat.pagesOuvertes).toBeLessThanOrEqual(resultat.pagesRequises);
    expect(resultat.resultats).toHaveLength(resultat.pagesOuvertes);
    expect(resultat.resultats.every((finding) => finding.extrait.includes("Contenu réel"))).toBe(true);
    // Le cœur de la demande est toujours la première requête.
    expect(resultat.requetes[0]).toContain("e-commerce");
  });

  it("applique la diversité par domaine (max 3 pages par domaine)", async () => {
    searchWebMock.mockResolvedValue(urlsPour(30, 1)); // UN SEUL domaine
    fetchImplMock = vi.fn(async () =>
      new Response("<html><body><p>Texte utile.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchImplMock);

    const resultat = await executeDeepResearch({ objective: OBJECTIF_SIMPLE });
    expect(resultat.pagesOuvertes).toBeLessThanOrEqual(3);
    expect(resultat.pagesOuvertes).toBeLessThan(resultat.pagesRequises);
    // Honnêteté : la note de budget est portée dans la synthèse.
    expect(resultat.synthese).toMatch(/\d+\/\d+ pages/);
  });

  it("déduplique les URLs communes aux requêtes différenciées", async () => {
    searchWebMock.mockImplementation(async () => urlsPour(20, 5)); // mêmes résultats à chaque requête
    fetchImplMock = vi.fn(async () =>
      new Response("<html><body><p>Texte utile.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchImplMock);

    const resultat = await executeDeepResearch({ objective: OBJECTIF_SIMPLE });
    const urls = resultat.resultats.map((finding) => finding.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("liste honnêtement les échecs de pages et continue la recherche", async () => {
    searchWebMock.mockResolvedValue(urlsPour(24, 6));
    fetchImplMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      // 1 page sur 3 échoue (HTTP 500) — la recherche continue.
      if (url.includes("page-3") || url.includes("page-9") || url.includes("page-15")) {
        return new Response("boom", { status: 500 });
      }
      return new Response("<html><body><p>Page correcte.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetchImplMock);

    const resultat = await executeDeepResearch({ objective: OBJECTIF_SIMPLE });
    expect(resultat.echecs.length).toBeGreaterThanOrEqual(2);
    expect(resultat.echecs[0].raison).toContain("500");
    // Les échecs n'ont pas empêché d'ouvrir le plancher de pages.
    expect(resultat.pagesOuvertes).toBeGreaterThanOrEqual(10);
  });

  it("respecte un budget temps court (arrêt propre, note honnête)", async () => {
    searchWebMock.mockResolvedValue(urlsPour(40, 8));
    fetchImplMock = vi.fn(async () =>
      new Response("<html><body><p>Texte.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchImplMock);

    const resultat = await executeDeepResearch({ objective: OBJECTIF_SIMPLE, budgetMs: 6_000 });
    expect(resultat.pagesRequises).toBeGreaterThanOrEqual(10);
    expect(resultat.dureeMs).toBeLessThan(20_000);
  });

  it("honore minPages quand l'appelant exige davantage de pages", async () => {
    searchWebMock.mockResolvedValue(urlsPour(40, 8));
    fetchImplMock = vi.fn(async () =>
      new Response("<html><body><p>Texte utile pour la lecture approfondie.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetchImplMock);

    const resultat = await executeDeepResearch({ objective: OBJECTIF_SIMPLE, minPages: 20 });
    expect(resultat.pagesRequises).toBeGreaterThanOrEqual(20);
    expect(resultat.pagesOuvertes).toBeGreaterThanOrEqual(20);
  });

  it("continue même si un moteur de recherche échoue totalement (aucun crash)", async () => {
    searchWebMock.mockRejectedValue(new Error("moteur indisponible"));
    vi.stubGlobal("fetch", vi.fn());

    const resultat = await executeDeepResearch({ objective: OBJECTIF_SIMPLE, budgetMs: 6_000 });
    expect(resultat.pagesOuvertes).toBe(0);
    expect(resultat.resultats).toHaveLength(0);
    expect(resultat.synthese).toContain("0/"); // note honnête explicite
  });
});
