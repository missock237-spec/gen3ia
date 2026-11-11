/* ------------------------------------------------------------------ */
/* EXTRACTION STRUCTURÉE DE PAGE — Cheerio (architecture propriétaire) */
/* ------------------------------------------------------------------ */
/* La demande : « Extraction et vérification — Contenu, dates, sources  */
/* ». Le fetch brut + markupToText (web.open historique) livre tout le   */
/* texte de la page, menus compris. Ici l'extraction est STRUCTURÉE :    */
/*   - JSON-LD (schema.org Article/NewsArticle) : titre, date, auteur ;  */
/*   - OpenGraph : og:title, og:description, article:published_time ;    */
/*   - contenu principal : densité de texte par bloc (l'élément avec le  */
/*     plus de texte lisible gagne), scripts/nav/footer/asides exclus.   */
/* Cheerio est un parseur HTML réel (pas de regex sur le chemin critique) */
/* et tourne partout où Node tourne — aucun navigateur requis.          */

import * as cheerio from "cheerio";

import type { PageExtraite } from "../types";

/** Éléments qui ne participent jamais au contenu principal. */
const SELECTEURS_EXCLUS = [
  "script", "style", "noscript", "template", "svg", "iframe", "form",
  "nav", "header", "footer", "aside", "button", "select", "dialog",
  "[role=navigation]", "[role=banner]", "[role=dialog]",
  "[aria-hidden=true]", "[hidden]",
].join(", ");

interface ArticleSchema {
  headline?: string;
  datePublished?: string;
  dateModified?: string;
  author?: { name?: string } | Array<{ name?: string }>;
}

/** Extraction structurée d'un document HTML. */
export function extrairePageHtml(html: string, url: string, urlFinale?: string): Omit<PageExtraite, "methode"> {
  const $ = cheerio.load(html);
  const caracteresBruts = $("body").text().length;

  // ---- Métadonnées JSON-LD (schema.org) ----
  let article: ArticleSchema = {};
  $('script[type="application/ld+json"]').each((_, el) => {
    const brut = $(el).contents().text().trim();
    if (!brut) return;
    try {
      const data = JSON.parse(brut) as unknown;
      const candidats = Array.isArray(data) ? data : [data];
      const trouvé = candidats.find(
        (c) =>
          c && typeof c === "object" &&
          ["@type" in c && String((c as Record<string, unknown>)["@type"]), ""].join("").match(/Article|NewsArticle|BlogPosting|WebPage/i),
      );
      if (trouvé) article = { ...article, ...(trouvé as ArticleSchema) };
    } catch {
      /* JSON-LD malformé : ignoré sans bloquer l'extraction */
    }
  });

  // ---- OpenGraph / meta standard ----
  const og = (cle: string) =>
    $(`meta[property="${cle}"]`).attr("content")?.trim() ||
    $(`meta[name="${cle}"]`).attr("content")?.trim() ||
    undefined;

  const titre =
    (og("og:title") ??
      (article.headline ? article.headline.trim() : undefined)) ||
    $("h1").first().text().trim() ||
    $("title").text().trim() ||
    undefined;

  const description = og("og:description") ?? og("description") ?? undefined;

  const datePublication =
    (og("article:published_time") ??
      article.datePublished ??
      $('time[datetime]').first().attr("datetime")?.trim()) || undefined;

  const auteurBrut = article.author;
  const auteur =
    (Array.isArray(auteurBrut) ? auteurBrut[0]?.name?.trim() : auteurBrut?.name?.trim()) ||
    og("article:author") ||
    undefined;

  // ---- Contenu principal par densité de texte ----
  $(SELECTEURS_EXCLUS).remove();
  let meilleurTexte = "";
  let meilleurScore = 0;
  $("article, main, [role=main], .article, .post, .content, #content, section, div, body").each((_, el) => {
    const texte = $(el).text().replace(/\s+/g, " ").trim();
    if (texte.length < 200) return;
    // La densité pénalise les conteneurs (div qui contiennent tout) :
    // le score favorise les blocs à texte concentré.
    const enfants = $(el).children().length;
    const score = texte.length / (1 + enfants * 0.1);
    if (score > meilleurScore) {
      meilleurScore = score;
      meilleurTexte = texte;
    }
  });
  if (!meilleurTexte) meilleurTexte = $("body").text().replace(/\s+/g, " ").trim();

  return {
    url,
    urlFinale,
    titre,
    datePublication,
    auteur,
    texte: meilleurTexte,
    description,
    caracteresBruts,
  };
}
