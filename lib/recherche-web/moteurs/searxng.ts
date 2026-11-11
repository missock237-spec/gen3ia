/* ------------------------------------------------------------------ */
/* MOTEUR SEARXNG — méta-moteur auto-hébergeable (sans clé)            */
/* ------------------------------------------------------------------ */
/* SearXNG est le méta-moteur open source cité dans l'architecture      */
/* propriétaire : auto-hébergeable, il agrège lui-même Google/Bing/     */
/* Brave/… et expose une API JSON. gen3ia l'utilise quand une instance  */
/* est configurée (SEARXNG_URL) — c'est le chemin le plus stable et le  */
/* plus « politique » (aucune dépendance à un SERP commercial).         */
/* Instance absente ou injoignable → échec propre, l'agrégateur         */
/* continue avec DuckDuckGo/Bing/Wikipédia.                             */

import type { ResultatRecherche } from "../types";

/** URL de l'instance SearXNG, si configurée (env au moment du runtime). */
export function urlSearxng(): string | undefined {
  const brute = process.env.SEARXNG_URL?.trim();
  if (!brute) return undefined;
  return brute.replace(/\/+$/, "");
}

/** Formats de sortie SearXNG acceptés (JSON natif de l'API ?format=json). */
export async function chercherSearxng(query: string, maxResults = 8): Promise<ResultatRecherche[]> {
  const base = urlSearxng();
  if (!base) throw new Error("SearXNG : aucune instance configurée (SEARXNG_URL).");
  const params = new URLSearchParams({
    q: query,
    format: "json",
    language: "fr",
    safesearch: "1",
  });
  const reponse = await fetch(`${base}/search?${params.toString()}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!reponse.ok) throw new Error(`SearXNG a répondu ${reponse.status}.`);
  const data = (await reponse.json()) as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      publishedDate?: string;
      engine?: string;
    }>;
  };
  const resultats = (data.results ?? [])
    .filter((item) => typeof item.url === "string" && item.url.length > 0 && typeof item.title === "string")
    .slice(0, maxResults)
    .map((item) => ({
      titre: (item.title ?? "").trim(),
      url: item.url as string,
      extrait: item.content?.trim(),
      publieLe: item.publishedDate?.trim(),
      moteur: "searxng",
    }));
  if (resultats.length === 0) throw new Error("SearXNG : aucun résultat exploitable.");
  return resultats;
}
