/* ------------------------------------------------------------------ */
/* MOTEUR DUCKDUCKGO — scraping HTML réel, sans clé                    */
/* ------------------------------------------------------------------ */
/* Port du parseur éprouvé (invariant de comportement conservé) vers     */
/* CHEERIO : redirecteur /l/?uddg= décodé, challenge anti-robot détecté  */
/* → échec propre pour la cascade. Cheerio est le parseur désigné par    */
/* l'architecture propriétaire pour l'extraction HTML.                   */

import * as cheerio from "cheerio";

import type { ResultatRecherche } from "../types";
import { resultatsPertinents } from "../verification/pertinence";
import { markupToText } from "@/lib/content/html-text";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function decodeDuckDuckGoHref(href: string): string | null {
  try {
    if (href.startsWith("//")) href = `https:${href}`;
    const url = new URL(href, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Parse une page SERP DuckDuckGo HTML avec Cheerio — exporté pour test
 *  sans réseau. */
export function parserDuckDuckGoHtml(html: string, maxResults = 8): ResultatRecherche[] {
  const $ = cheerio.load(html);
  const resultats: ResultatRecherche[] = [];
  $("a.result__a").each((_, element) => {
    if (resultats.length >= maxResults) return false;
    const ancre = $(element);
    const url = decodeDuckDuckGoHref(ancre.attr("href") ?? "");
    if (!url) return;
    const titre = markupToText(ancre.html() ?? "").trim();
    if (!titre) return;
    // Le snippet est le .result__snippet suivant dans le même bloc résultat.
    const bloc = ancre.closest("div.result, div.result__body, div").first();
    const snippet = bloc.find("a.result__snippet").first().text();
    resultats.push({
      titre,
      url,
      extrait: snippet ? markupToText(snippet).trim() : undefined,
      moteur: "duckduckgo",
    });
  });
  return resultats;
}

/** Recherche web réelle via DuckDuckGo HTML (sans clé). Échoue proprement. */
export async function chercherDuckDuckGo(query: string, maxResults = 8): Promise<ResultatRecherche[]> {
  const params = new URLSearchParams({ q: query });
  const response = await fetch(`https://html.duckduckgo.com/html/?${params.toString()}`, {
    headers: {
      "user-agent": BROWSER_UA,
      "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`DuckDuckGo a répondu ${response.status}.`);
  const html = await response.text();
  if (!html.includes("result")) throw new Error("DuckDuckGo : challenge anti-robot.");
  // Garde de pertinence : un SERP hors sujet (mur anti-bot canned) ne doit
  // jamais alimenter le contexte sourcé du chat — échec propre pour la cascade.
  const resultats = resultatsPertinents(parserDuckDuckGoHtml(html, maxResults), query);
  if (resultats.length === 0) throw new Error("DuckDuckGo : aucun résultat pertinent parsable.");
  return resultats;
}
