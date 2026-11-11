import { describe, expect, it } from "vitest";

import { parserBingHtml } from "./bing";

/** Fixture SERP Bing réaliste (structure b_algo / h2 a / b_lineclamp). */
const SERP_BING = `
<html><body><ol id="b_results">
<li class="b_algo">
  <h2><a href="https://exemple1.com/article?utm_source=b" h="ID=SERP,5186.1">Premier résultat : Intelligence artificielle</a></h2>
  <div class="b_caption"><p class="b_lineclamp b_paractc">L'intelligence artificielle progresse vite cette année selon les experts du domaine.</p></div>
  <span class="news_dt">12 nov.</span>
</li>
<li class="b_algo">
  <h2><a href="/ck/a?u=a1aHR0cHM6Ly9leGVtcGxlMi5jb20vcGFnZQ==&ntb=1" h="ID=SERP,5187.1">Deuxième résultat encodé</a></h2>
  <div class="b_caption"><p class="b_lineclamp">Résumé du deuxième article de test avec du contenu suffisant.</p></div>
</li>
<li class="b_algo">
  <h2><a href="https://www.bing.com/interne" h="ID=SERP">Lien interne Bing à exclure</a></h2>
  <p>Extrait</p>
</li>
</ol></body></html>
`;

describe("recherche-web — moteur Bing (parsing SERP HTML)", () => {
  it("extrait les résultats organiques avec titre, URL, extrait et date", () => {
    const resultats = parserBingHtml(SERP_BING, 10);
    expect(resultats).toHaveLength(2); // le lien interne bing.com est exclu
    expect(resultats[0].titre).toBe("Premier résultat : Intelligence artificielle");
    // Le parsing conserve l'URL telle quelle — le nettoyage du tracking
    // (utm) est le rôle de la normalisation au dédoublonnage.
    expect(resultats[0].url).toContain("exemple1.com/article");
    expect(resultats[0].extrait).toContain("intelligence artificielle progresse");
    expect(resultats[0].moteur).toBe("bing");
    expect(resultats[0].publieLe).toContain("nov");
  });

  it("décode le lien de tracking /ck/a (base64 a1…)", () => {
    const resultats = parserBingHtml(SERP_BING, 10);
    expect(resultats[1].url).toBe("https://exemple2.com/page");
  });

  it("respecte maxResults", () => {
    expect(parserBingHtml(SERP_BING, 1)).toHaveLength(1);
  });

  it("renvoie vide sur une page sans résultats (challenge anti-robot)", () => {
    expect(parserBingHtml("<html><body>Captcha</body></html>", 8)).toEqual([]);
  });
});
