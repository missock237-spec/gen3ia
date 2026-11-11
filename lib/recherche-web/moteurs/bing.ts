/* ------------------------------------------------------------------ */
/* MOTEUR BING — scraping HTML réel, sans clé                          */
/* ------------------------------------------------------------------ */
/* Bing (www.bing.com/search) est un des moteurs demandés par           */
/* l'architecture propriétaire. La page SERP HTML publique est parsée   */
/* avec CHEERIO (parseur HTML réel — l'architecture propriétaire le     */
/* désigne pour l'extraction) : chaque résultat vit dans li.b_algo avec  */
/* un titre h2 a, un extrait p et souvent une date. Les liens de        */
/* tracking /ck/a (base64 a1…) sont décodés vers l'URL réelle. Bing peut*/
/* répondre un challenge (page sans b_algo) : on échoue alors proprement*/
/* pour laisser l'agrégateur passer aux autres moteurs.                 */

import * as cheerio from "cheerio";

import type { ResultatRecherche } from "../types";
import { resultatsPertinents } from "../verification/pertinence";
import { markupToText } from "@/lib/content/html-text";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Décode une href Bing : liens internes exclus, /ck/a (base64 a1…)
 *  décodé vers l'URL réelle. Exporté pour test. */
export function decoderHrefBing(href: string): string | null {
  try {
    if (href.startsWith("//")) href = `https:${href}`;
    const url = new URL(href, "https://www.bing.com");
    // Bing route parfois via /ck/a?...&u=a1<url base64> — décodage réel.
    if (url.pathname.startsWith("/ck/")) {
      const u = url.searchParams.get("u");
      if (u?.startsWith("a1")) {
        const decodee = Buffer.from(u.slice(2), "base64").toString("utf8");
        if (/^https?:\/\//.test(decodee)) return decodee;
      }
      return null; // lien de tracking non décodable : ignoré
    }
    // Liens internes Bing/Microsoft exclus — SANS avaler un domaine externe
    // qui finirait par « bing.com » (ex. « seul-bing.com ») : vérification
    // exacte ou sous-domaine point.
    const hote = url.hostname.toLowerCase();
    if (hote === "bing.com" || hote.endsWith(".bing.com") || hote === "microsoft.com" || hote.endsWith(".microsoft.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Parse les résultats d'une page SERP Bing (HTML réel) avec Cheerio —
 *  exporté pour être testé sans réseau. */
export function parserBingHtml(html: string, maxResults = 8): ResultatRecherche[] {
  const $ = cheerio.load(html);
  const resultats: ResultatRecherche[] = [];
  $("li.b_algo").each((_, element) => {
    if (resultats.length >= maxResults) return false; // stop the iteration
    const li = $(element);
    const ancre = li.find("h2 a").first();
    const href = ancre.attr("href");
    const titre = markupToText(ancre.html() ?? "").trim();
    if (!href || !titre) return;
    const url = decoderHrefBing(href);
    if (!url) return;
    // Extrait : p.b_lineclamp d'abord, sinon premier p du bloc.
    const pExtrait = li.find("p.b_lineclamp").first().text() || li.find("p").first().text();
    const extrait = markupToText(pExtrait).trim();
    // Date : span.news_dt ou attribut datetime.
    const dateBrute = li.find("span.news_dt").first().text().trim() || li.find("[datetime]").first().attr("datetime")?.trim() || "";
    resultats.push({
      titre,
      url,
      extrait: extrait || undefined,
      publieLe: dateBrute || undefined,
      moteur: "bing",
    });
  });
  return resultats;
}

/** Recherche web réelle via Bing (page HTML, sans clé). Le chemin HTTP
 *  est essayé d'abord ; si la page ne contient pas de résultats (challenge
 *  anti-robot fréquent depuis les IP datacenter), le rendu CHROMIUM réel
 *  (Playwright — architecture propriétaire : « Playwright, Chromium ») est
 *  tenté : un vrai navigateur exécute le JS du challenge et la SERP rendue
 *  est reparsée. Échoue proprement (throw) pour laisser la cascade continuer. */
export async function chercherBing(query: string, maxResults = 8): Promise<ResultatRecherche[]> {
  const params = new URLSearchParams({ q: query, count: String(Math.min(maxResults, 20)), mkt: "fr-FR", setlang: "fr" });
  const urlSerp = `https://www.bing.com/search?${params.toString()}`;
  const enTetes = { "user-agent": BROWSER_UA, "accept-language": "fr-FR,fr;q=0.9,en;q=0.8" };

  const raisonHttp: string[] = [];
  try {
    const reponse = await fetch(urlSerp, {
      headers: enTetes,
      signal: AbortSignal.timeout(20_000),
    });
    if (!reponse.ok) throw new Error(`Bing a répondu ${reponse.status}.`);
    const html = await reponse.text();
    // Garde de pertinence : le mur anti-bot de Bing sert parfois une SERP
    // HTTP 200 structurellement valide mais CANNED et hors sujet — sans la
    // garde, ces résultats poubelle entreraient dans le contexte du chat.
    const resultats = resultatsPertinents(parserBingHtml(html, maxResults), query);
    if (resultats.length > 0) return resultats;
    raisonHttp.push("HTTP : aucun résultat pertinent (challenge ou SERP canned)");
  } catch (erreur) {
    raisonHttp.push(`HTTP : ${erreur instanceof Error ? erreur.message : "échec"}`);
  }

  // Repli rendu réel : Chromium exécute le JS du challenge, la SERP rendue
  // contient les résultats (li.b_algo) que le parseur Cheerio relit.
  try {
    const { rendreHtmlAvecChromium } = await import("@/lib/recherche-web/extraction/navigation-playwright");
    const htmlRendu = await rendreHtmlAvecChromium(urlSerp, 25_000);
    const resultats = resultatsPertinents(parserBingHtml(htmlRendu, maxResults), query);
    if (resultats.length > 0) return resultats;
    raisonHttp.push("Chromium : page rendue sans résultats pertinents");
  } catch {
    raisonHttp.push("Chromium indisponible");
  }
  throw new Error(`Bing inaccessible (${raisonHttp.join(" | ")}).`);
}
