import { describe, expect, it } from "vitest";

import { parserDuckDuckGoHtml } from "./duckduckgo";

/** Fixture SERP DuckDuckGo HTML (structure result__a / result__snippet). */
const SERP_DDG = `
<html><body>
<div class="result__body">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexemple1.com%2Fpage&amp;rut=abc">Premier titre <b>test</b></a>
  <a class="result__snippet" href="#">Extrait du premier résultat de test.</a>
</div>
<div class="result__body">
  <a class="result__a" href="https://exemple2.com/direct">Deuxième titre direct</a>
  <a class="result__snippet" href="#">Extrait du deuxième résultat.</a>
</div>
</body></html>
`;

describe("recherche-web — moteur DuckDuckGo (parsing SERP HTML)", () => {
  it("décode les liens redirecteur /l/?uddg= et les liens directs", () => {
    const resultats = parserDuckDuckGoHtml(SERP_DDG, 10);
    expect(resultats).toHaveLength(2);
    expect(resultats[0].url).toBe("https://exemple1.com/page");
    expect(resultats[1].url).toBe("https://exemple2.com/direct");
    expect(resultats[0].titre).toBe("Premier titre test");
    expect(resultats[0].moteur).toBe("duckduckgo");
  });

  it("associe les snippets aux bons titres", () => {
    const resultats = parserDuckDuckGoHtml(SERP_DDG, 10);
    expect(resultats[0].extrait).toContain("premier résultat");
    expect(resultats[1].extrait).toContain("deuxième résultat");
  });

  it("renvoie vide sans résultats parsables", () => {
    expect(parserDuckDuckGoHtml("<html></html>", 8)).toEqual([]);
  });
});
