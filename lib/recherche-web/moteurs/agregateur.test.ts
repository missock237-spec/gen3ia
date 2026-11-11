import { afterEach, describe, expect, it, vi } from "vitest";

import { agregerMoteurs } from "./agregateur";

/** SERP minimaux pour stuber fetch sans réseau. */
const SERP_DDG = `
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcommun.com%2Fa&amp;rut=x">Résultat commun DDG</a>
<a class="result__snippet" href="#">Extrait commun aux deux moteurs de test.</a>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fseul-ddg.com%2Fb&amp;rut=x">Seul chez DDG</a>
<a class="result__snippet" href="#">Extrait propre à DuckDuckGo dans ce test.</a>
`;
const SERP_BING = `
<li class="b_algo"><h2><a href="https://commun.com/a">Résultat commun Bing</a></h2>
<p class="b_lineclamp">Extrait commun aux deux moteurs de test.</p></li>
<li class="b_algo"><h2><a href="https://seul-bing.com/c">Seul chez Bing</a></h2>
<p class="b_lineclamp">Extrait propre à Bing dans ce test d'agrégation.</p></li>
`;

function reponseHtml(html: string): Response {
  return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recherche-web — agrégateur multi-moteurs (fetch stubés)", () => {
  it("fusionne DDG + Bing, dédoublonne le résultat commun et compte les confirmations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (entree: string | URL) => {
        const url = String(entree);
        if (url.includes("duckduckgo")) return reponseHtml(SERP_DDG);
        if (url.includes("bing.com")) return reponseHtml(SERP_BING);
        throw new Error(`hôte inattendu : ${url}`);
      }),
    );
    const { resultats, diagnostic } = await agregerMoteurs("test d'agrégation", { maxResults: 10 });

    expect(diagnostic.moteursInterroges).toEqual(["duckduckgo", "bing"]);
    expect(diagnostic.moteursOperatifs).toEqual(["duckduckgo", "bing"]);
    expect(diagnostic.moteursEnEchec).toHaveLength(0);
    expect(diagnostic.resultatsBruts).toBe(4);
    // « commun.com/a » vu par les 2 moteurs : dédoublonné (contenu identique
    // + même URL) → 3 résultats uniques, 1 doublon retiré.
    expect(diagnostic.resultatsUniques).toBe(3);
    expect(diagnostic.doublonsRetires).toBe(1);

    const commun = resultats.find((r) => r.url.includes("commun.com"));
    expect(commun).toBeDefined();
    expect(commun!.confirmations).toBe(2); // confirmé par les 2 moteurs
    expect(commun!.score).toBeGreaterThan(10); // bonus confirmations
  });

  it("un moteur en échec est DIT dans le diagnostic, les autres continuent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (entree: string | URL) => {
        const url = String(entree);
        // DDG répond 202 avec une page challenge (sans « result ») :
        // c'est exactement le cas réel anti-robot du parseur.
        if (url.includes("duckduckgo")) return reponseHtml("<html><body>challenge JS</body></html>");
        if (url.includes("bing.com")) return reponseHtml(SERP_BING);
        throw new Error(`hôte inattendu : ${url}`);
      }),
    );
    const { resultats, diagnostic } = await agregerMoteurs("test résilience", { maxResults: 5 });
    expect(diagnostic.moteursOperatifs).toEqual(["bing"]);
    expect(diagnostic.moteursEnEchec).toHaveLength(1);
    expect(diagnostic.moteursEnEchec[0].moteur).toBe("duckduckgo");
    expect(diagnostic.moteursEnEchec[0].raison.toLowerCase()).toContain("challenge");
    expect(resultats.length).toBeGreaterThan(0); // Bing a répondu, le tour continue
  });

  it("tri par score : les résultats mieux notés d'abord", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (entree: string | URL) => {
        const url = String(entree);
        if (url.includes("duckduckgo")) return reponseHtml(SERP_DDG);
        if (url.includes("bing.com")) return reponseHtml(SERP_BING);
        throw new Error(`hôte inattendu : ${url}`);
      }),
    );
    const { resultats } = await agregerMoteurs("test du tri", { maxResults: 10 });
    const scores = resultats.map((r) => r.score);
    const tries = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(tries);
  });
});
