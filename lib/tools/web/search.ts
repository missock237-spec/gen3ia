import { z } from "zod";

import { markupToText } from "@/lib/content/html-text";
// MOTEUR DE RECHERCHE WEB TEMPS RÉEL gen3ia (architecture propriétaire
// 2026-11-11) : agrégation multi-moteurs DuckDuckGo + Bing + SearXNG,
// dédoublonnage URL/contenu, vérification des sources. Le tool historique
// garde sa cascade, mais sa SORTIE UTILISATEUR est devenue un RAPPORT
// détaillé et autonome (demande propriétaire : l'utilisateur ne voit plus
// les sources) — les résultats bruts restent dans le champ interne
// `__interne.resultats`, retiré de toute sérialisation (voir toJSON).
import { agregerMoteurs } from "@/lib/recherche-web/moteurs/agregateur";
import {
  construirRapportRecherche,
} from "@/lib/recherche-web/rapport";

import type {
  ToolDefinition,
} from "../types";

const SearchInput =
  z.object({
    query:
      z.string().min(2),

    maxResults:
      z.number()
        .int()
        .min(1)
        .max(20)
        .default(10),
  });

interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  /** Source gratuite utilisée (ex. « Wikipédia (fr) ») en repli. */
  source?: string;
}

/** Sortie UTILISATEUR du tool web.search : un rapport autonome.
 *  AUCUNE liste de résultats, AUCUNE URL, AUCUNE mention de sources —
 *  le rapport se suffit à lui-même (titres thématiques, points clés,
 *  nuances, synthèse). Les résultats bruts ne sortent QUE dans le champ
 *  interne `__interne.resultats`, et uniquement pour le moteur gen3 :
 *  ils peuvent être cités À L'ORAL si l'utilisateur les demande
 *  explicitement, jamais en liste automatique. */
export interface SortieRechercheWebTool {
  /** Rapport détaillé en français (sections thématiques, points clés,
   *  nuances, synthèse) — sans URL ni nom de domaine. */
  rapport: string;
  /** Nombre de sections thématiques détectées dans le rapport. */
  sections: number;
  /** Fiabilité d'ensemble selon le volume recueilli. */
  fiabilite: "haute" | "moyenne" | "basse";
  /** Diagnostic honnête du tour (moteurs opérationnels / en échec). */
  diagnostic?: {
    moteursOperatifs: string[];
    moteursEnEchec: Array<{ moteur: string; raison: string }>;
    doublonsRetires: number;
  };
}

interface SearchResponse extends SortieRechercheWebTool {
  /** Résultats bruts (titre/URL/extrait) réservés AU MOTEUR gen3 : ils
   *  alimentent le canal interne (pont connaissances, synthèses de plan)
   *  et ne sont JAMAIS sérialisés vers l'utilisateur — voir toJSON. */
  __interne: { resultats: SearchResult[] };
  /** Sérialisation publique : timeline, streaming, persistance et prompts
   *  ne reçoivent QUE le rapport — les URL brutes ne fuient nulle part. */
  toJSON(): SortieRechercheWebTool;
}

/** Sortie BRUTE intermédiaire des fournisseurs (provider cléé, Wikipédia,
 *  DuckDuckGo direct) : uniquement consommée par reponseDepuisResultats,
 *  jamais exposée telle quelle au moteur conversationnel. */
interface ResultatsBrutsFournisseur {
  results: SearchResult[];
}

/** Assemble la réponse finale : rapport utilisateur + résultats bruts
 *  internes (jamais sérialisés) + diagnostic honnête. */
function reponseDepuisResultats(
  query: string,
  resultats: SearchResult[],
  diagnostic?: SortieRechercheWebTool["diagnostic"],
): SearchResponse {
  const rapport = construirRapportRecherche(
    query,
    resultats.map((resultat) => ({
      titre: resultat.title,
      extrait: resultat.snippet,
      publieLe: resultat.publishedAt,
    })),
  );
  return {
    rapport: rapport.texte,
    sections: rapport.sections,
    fiabilite: rapport.fiabilite,
    ...(diagnostic ? { diagnostic } : {}),
    __interne: { resultats },
    toJSON() {
      return {
        rapport: rapport.texte,
        sections: rapport.sections,
        fiabilite: rapport.fiabilite,
        ...(diagnostic ? { diagnostic } : {}),
      };
    },
  };
}

async function executeSearch(
  input: z.infer<
    typeof SearchInput
  >,
): Promise<SearchResponse> {
  const provider =
    process.env.SEARCH_PROVIDER;
  const apiKey =
    process.env.SEARCH_API_KEY;

  // Cascade de repli :
  //   1. provider cléé (tavily/serper/serpapi) si configuré ;
  //   2. moteur multi-moteurs SANS CLÉ (SearXNG si configuré, DuckDuckGo
  //      + Bing en parallèle, Wikipédia en repli encyclopédique) ;
  //   3. Wikipédia direct si l'agrégateur entier échoue (cascade finale).
  // L'agent ne rend jamais la main avec un échec sec.
  if (provider && apiKey) {
    try {
      const brutProvider = await executeSearchWithProvider(provider, apiKey, input);
      if (brutProvider.results.length > 0) {
        return reponseDepuisResultats(input.query, brutProvider.results);
      }
    } catch {
      /* repli ci-dessous */
    }
  } else if (provider && !apiKey) {
    throw new Error(
      "SEARCH_API_KEY is not configured.",
    );
  }

  try {
    const agregation = await agregerMoteurs(input.query, {
      maxResults: input.maxResults,
    });
    if (agregation.resultats.length > 0) {
      return reponseDepuisResultats(
        input.query,
        agregation.resultats.map((resultat) => ({
          title: resultat.titre,
          url: resultat.url,
          snippet: resultat.extrait,
          publishedAt: resultat.datePublication ?? resultat.publieLe,
          source: resultat.moteur,
        })),
        {
          moteursOperatifs: agregation.diagnostic.moteursOperatifs,
          moteursEnEchec: agregation.diagnostic.moteursEnEchec,
          doublonsRetires: agregation.diagnostic.doublonsRetires,
        },
      );
    }
  } catch {
    /* repli ci-dessous */
  }
  // Cascade finale : Wikipédia direct (source toujours disponible, sans clé).
  const repliWikipedia = await searchWikipedia(input.query, input.maxResults);
  if (repliWikipedia.results.length === 0) {
    throw new Error("Aucune source de recherche disponible.");
  }
  return reponseDepuisResultats(input.query, repliWikipedia.results);
}

async function executeSearchWithProvider(
  provider: string,
  apiKey: string,
  input: z.infer<typeof SearchInput>,
): Promise<ResultatsBrutsFournisseur> {
  switch (provider) {
    case "tavily":
      return searchTavily(
        input.query,
        input.maxResults,
        apiKey,
      );

    case "serper":
      return searchSerper(
        input.query,
        input.maxResults,
        apiKey,
      );

    case "serpapi":
      return searchSerpApi(
        input.query,
        input.maxResults,
        apiKey,
      );

    default:
      throw new Error(
        `Unsupported search provider: ${provider}`,
      );
  }
}

async function searchSerpApi(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<ResultatsBrutsFournisseur> {
  const params = new URLSearchParams({
    engine: "google",
    q: query,
    num: String(Math.min(maxResults, 20)),
    api_key: apiKey,
  });

  const response = await fetch(
    `https://serpapi.com/search?${params.toString()}`,
    // Timeout (audit 2026-10-28) : un provider qui pend ne retient pas
    // la requête utilisateur (budget chat amont non couvert ici).
    { signal: AbortSignal.timeout(15_000) },
  );

  if (!response.ok) {
    throw new Error(
      `SerpApi returned ${response.status}.`,
    );
  }

  const data =
    (await response.json()) as {
      organic_results?: Array<{
        title?: string;
        link?: string;
        snippet?: string;
        date?: string;
      }>;
    };

  return {
    results:
      (data.organic_results ?? [])
        .filter(
          (item) =>
            typeof item.link === "string" &&
            item.link.length > 0,
        )
        .map(
          (item) => ({
            title:
              item.title ?? "",

            url:
              item.link as string,

            snippet:
              item.snippet,

            publishedAt:
              item.date,
          }),
        ),
  };
}

async function searchTavily(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<ResultatsBrutsFournisseur> {
  const response =
    await fetch(
      "https://api.tavily.com/search",
      {
        method: "POST",

        signal: AbortSignal.timeout(15_000),

        headers: {
          "content-type":
            "application/json",
        },

        body: JSON.stringify({
          api_key:
            apiKey,

          query,

          max_results:
            maxResults,

          include_answer:
            false,

          include_raw_content:
            false,
        }),
      },
    );

  if (!response.ok) {
    throw new Error(
      `Tavily returned ${response.status}.`,
    );
  }

  const data =
    (await response.json()) as {
      results?: Array<{
        title: string;
        url: string;
        content?: string;
        published_date?: string;
      }>;
    };

  return {
    results:
      (data.results ?? []).map(
        (item) => ({
          title:
            item.title,

          url:
            item.url,

          snippet:
            item.content,

          publishedAt:
            item.published_date,
        }),
      ),
  };
}

async function searchSerper(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<ResultatsBrutsFournisseur> {
  const response =
    await fetch(
      "https://google.serper.dev/search",
      {
        method: "POST",

        signal: AbortSignal.timeout(15_000),

        headers: {
          "X-API-KEY":
            apiKey,

          "content-type":
            "application/json",
        },

        body: JSON.stringify({
          q: query,

          num:
            maxResults,
        }),
      },
    );

  if (!response.ok) {
    throw new Error(
      `Serper returned ${response.status}.`,
    );
  }

  const data =
    (await response.json()) as {
      organic?: Array<{
        title: string;
        link: string;
        snippet?: string;
        date?: string;
      }>;
    };

  return {
    results:
      (data.organic ?? []).map(
        (item) => ({
          title:
            item.title,

          url:
            item.link,

          snippet:
            item.snippet,

          publishedAt:
            item.date,
        }),
      ),
  };
}

export const webSearchTool:
  ToolDefinition<
    z.infer<
      typeof SearchInput
    >,
    SearchResponse
  > = {
    id:
      "web.search",

    name:
      "Web Search",

    description:
      "Recherche web temps réel. Livre un RAPPORT détaillé et autonome (rapport, sections, fiabilité) : ne produis JAMAIS une liste de sources ni d'URLs à partir de cette sortie ; si l'utilisateur demande explicitement les liens, cite-les oralement depuis __interne.resultats.",

    category:
      "web",

    risk:
      "low",

    inputSchema:
      SearchInput,

    execute:
      executeSearch,
  };

/**
 * Recherche BRUTE pour les modules serveur (moteurs de recherche internes,
 * planificateurs) qui ont besoin des résultats crus sans passer par le
 * registre d'outils. Usage MOTEUR : ne jamais afficher ces résultats en
 * liste automatique — passer par webSearchTool (rapport) pour l'utilisateur.
 */
export async function searchWeb(
  query: string,
  maxResults = 10,
): Promise<SearchResult[]> {
  const parsed =
    SearchInput.parse({ query, maxResults });

  const response =
    await executeSearch(parsed);

  return response.__interne.resultats;
}

/* ------------------------------------------------------------------ */
/* Sources gratuites (aucune clé requise)                              */
/* ------------------------------------------------------------------ */

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * DuckDuckGo HTML (html.duckduckgo.com/html) : résultats réels sans clé.
 * Les liens sortants passent par un redirecteur /l/?uddg=<url encodée>.
 * DDG peut répondre un challenge (202 / page JS) : on échoue alors proprement
 * pour laisser la cascade passer à Wikipédia.
 */
export async function searchDuckDuckGo(
  query: string,
  maxResults = 8,
): Promise<ResultatsBrutsFournisseur> {
  const params = new URLSearchParams({ q: query });
  const response = await fetch(`https://html.duckduckgo.com/html/?${params.toString()}`, {
    headers: {
      "user-agent": BROWSER_UA,
      "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`DuckDuckGo returned ${response.status}.`);
  const html = await response.text();
  if (!html.includes("result")) throw new Error("DuckDuckGo: challenge anti-robot.");

  const results: SearchResult[] = [];
  const blockRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>[\s\S]*?<\/a>/g;
  const snippets = html.match(snippetRegex) ?? [];

  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = blockRegex.exec(html)) !== null && results.length < maxResults) {
    const rawHref = match[1];
    const url = decodeDuckDuckGoHref(rawHref);
    if (!url) continue;
    const title = stripHtml(match[2]);
    if (!title) continue;
    results.push({
      title,
      url,
      snippet: snippets[index] ? stripHtml(snippets[index]) : undefined,
    });
    index += 1;
  }
  if (results.length === 0) throw new Error("DuckDuckGo: aucun résultat parsable.");
  return { results };
}

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

function stripHtml(html: string): string {
  // Machine à états (une passe, un seul décodage d'entité, balises
  // imbriquées inertes) — remplace la chaîne de regex vulnérable aux
  // évasions et signalée par CodeQL (double-escaping / bad-tag-filter).
  return markupToText(html);
}

/**
 * API Wikipédia (action=query&list=search) : source toujours disponible,
 * sans clé, avec extraits sourcés. Version française d'abord, anglaise
 * en repli.
 */
export async function searchWikipedia(
  query: string,
  maxResults = 8,
): Promise<ResultatsBrutsFournisseur> {
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
          // Conformité Wikimedia : UA identifiable avec point de contact.
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
      return {
        results: items.map((item) => ({
          title: item.title,
          url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`,
          snippet: item.snippet ? stripHtml(item.snippet) : undefined,
          publishedAt: item.timestamp,
          source: `Wikipédia (${lang})`,
        })),
      };
    } catch {
      /* on tente la langue suivante */
    }
  }
  throw new Error("Aucune source de recherche disponible.");
}
