import { describe, expect, it } from "vitest";

import { parserBingHtml } from "../moteurs/bing";
import { parserDuckDuckGoHtml } from "../moteurs/duckduckgo";
import { resultatPertinent, resultatsPertinents, termesRequete } from "./pertinence";
import type { ResultatRecherche } from "../types";

/** Fixture RÉELLE : mur anti-bot Bing observé par sonde le 2026-11-11 —
 *  SERP HTTP 200, li.b_algo structurellement valides, contenu CANNED hors
 *  sujet (« Best Buy » pour la requête « prix Bitcoin aujourd'hui »). */
const SERP_MUR_ANTI_BOT = `
<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://www.bestbuy.com/military-discount">20% Off Best Buy Military Discount &amp; How to Get Online</a></h2>
  <div class="b_caption"><p class="b_lineclamp">Active duty members and veterans save with our discount program.</p></div></li>
<li class="b_algo"><h2><a href="https://www.elevenforum.com/folder-layout">Change Folder Layout View in Windows 11 File Explorer</a></h2>
  <div class="b_caption"><p class="b_lineclamp">Customize how files and folders are displayed in Explorer.</p></div></li>
<li class="b_algo"><h2><a href="https://exemple-support.com/windows">File Explorer in Windows | Microsoft Support</a></h2>
  <div class="b_caption"><p class="b_lineclamp">Find and open File Explorer in Windows 10 and 11.</p></div></li>
</ol></body></html>
`;

/** Fixture SERP réaliste : résultats réellement liés à la requête. */
const SERP_REELLE = `
<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://exemple-crypto.com/cours">Cours du Bitcoin aujourd'hui : prix en direct</a></h2>
  <div class="b_caption"><p class="b_lineclamp">Le prix du Bitcoin évolue de 2,4 % depuis ce matin.</p></div></li>
<li class="b_algo"><h2><a href="https://exemple-actu.com/marches">Prix Bitcoin : la crypto repart à la hausse</a></h2>
  <div class="b_caption"><p class="b_lineclamp">Analyse du marché des crypto-monnaies et du cours du Bitcoin.</p></div></li>
</ol></body></html>
`;

function resultat(titre: string, extrait?: string): ResultatRecherche {
  return { titre, url: "https://exemple.com", extrait, moteur: "test" };
}

describe("recherche-web — garde de pertinence (murs anti-bot canned)", () => {
  it("termesRequete garde les termes porteurs et filtre les mots vides", () => {
    expect(termesRequete("prix Bitcoin aujourd'hui")).toEqual(["prix", "bitcoin"]);
    expect(termesRequete("dernières actualités IA novembre 2026")).toContain("actualites");
    expect(termesRequete("cours de la bourse en 2026")).toContain("bourse");
  });

  it("une requête sans terme porteur fail-open (liste inchangée)", () => {
    const resultats = [resultat("N'importe quoi hors sujet")];
    expect(resultatsPertinents(resultats, "que faire ?")).toEqual(resultats);
  });

  it("la SERP mur anti-bot Bing est REJETÉE en bloc (parser + garde)", () => {
    const bruts = parserBingHtml(SERP_MUR_ANTI_BOT, 8);
    expect(bruts).toHaveLength(3); // structurellement valides…
    expect(resultatsPertinents(bruts, "prix Bitcoin aujourd'hui")).toEqual([]); // …mais rejetés
  });

  it("la SERP réaliste passe la garde intacte", () => {
    const bruts = parserBingHtml(SERP_REELLE, 8);
    const gardes = resultatsPertinents(bruts, "prix Bitcoin aujourd'hui");
    expect(gardes).toHaveLength(2);
    expect(gardes[0].titre).toContain("Cours du Bitcoin");
  });

  it("les résultats individuels hors sujet sont filtrés, les pertinents gardés", () => {
    const termes = termesRequete("prix Bitcoin aujourd'hui");
    expect(resultatPertinent(resultat("Best Buy Military Discount"), termes)).toBe(false);
    expect(resultatPertinent(resultat("Le prix du Bitcoin s'envole", "analyse du marché"), termes)).toBe(true);
  });

  it("les accents ne masquent pas la pertinence (é = e)", () => {
    const termes = termesRequete("classement Ligue 1");
    expect(resultatPertinent(resultat("Résultats de la ligue et classement à jour"), termes)).toBe(true);
  });

  it("la garde s'applique aussi au parsing DuckDuckGo", () => {
    const ddgCanned = `
<html><body>
<div class="result__body"><a class="result__a" href="https://recettes.com/gateau">Recette de gâteau au chocolat</a>
<a class="result__snippet" href="#">Une délicieuse recette facile.</a></div>
</body></html>`;
    const bruts = parserDuckDuckGoHtml(ddgCanned, 8);
    expect(bruts).toHaveLength(1);
    expect(resultatsPertinents(bruts, "prix Bitcoin aujourd'hui")).toEqual([]);
  });
});
