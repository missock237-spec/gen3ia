/* ------------------------------------------------------------------ */
/* SOURCE WIKIPÉDIA — repli encyclopédique sourcé, sans clé            */
/* ------------------------------------------------------------------ */
/* Port de la cascade existante (lib/tools/web/search.ts) : API MediaWiki */
/* officielle (action=query&list=search), français d'abord, anglais en    */
/* repli. Conformité Wikimedia : User-Agent identifiable avec contact.    */

import type { ResultatRecherche } from "../types";
import { markupToText } from "@/lib/content/html-text";

export async function chercherWikipedia(query: string, maxResults = 8): Promise<ResultatRecherche[]> {
  for (const lang of ["fr", "en"]) {
    try {
      const params = new URLSearchParams({
        action: "query",
        list: "search",
        srsearch: query,
        srlimit: String(Math.min(maxResults, 20)),
        format: "json",
        origin: "*",
      });
      const response = await fetch(`https://${lang}.wikipedia.org/w/api.php?${params.toString()}`, {
        headers: {
          "user-agent": "Gen3iaBot/1.0 (https://gen3ia.online; contact@gen3ia.online)",
          accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) continue;
      const data = (await response.json()) as {
        query?: { search?: Array<{ title: string; snippet?: string; timestamp?: string }> };
      };
      const items = data.query?.search ?? [];
      if (items.length === 0) continue;
      return items.map((item) => ({
        titre: item.title,
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`,
        extrait: item.snippet ? markupToText(item.snippet).trim() : undefined,
        publieLe: item.timestamp,
        moteur: `wikipedia-${lang}`,
      }));
    } catch {
      /* on tente la langue suivante */
    }
  }
  throw new Error("Wikipédia : aucune langue répondante.");
}
