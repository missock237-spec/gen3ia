import { z } from "zod";

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

interface SearchResponse {
  results: SearchResult[];
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

  // Cascade de repli : provider cléé (tavily/serper/serpapi) si configuré,
  // sinon DuckDuckGo HTML (sans clé), sinon API Wikipedia (sans clé, sourcée).
  // Un moteur configuré qui échoue retombe aussi sur les sources gratuites :
  // l'agent ne rend jamais la main avec un échec sec.
  if (provider && apiKey) {
    try {
      return await executeSearchWithProvider(provider, apiKey, input);
    } catch {
      /* repli ci-dessous */
    }
  } else if (provider && !apiKey) {
    throw new Error(
      "SEARCH_API_KEY is not configured.",
    );
  }

  try {
    return await searchDuckDuckGo(input.query, input.maxResults);
  } catch {
    return searchWikipedia(input.query, input.maxResults);
  }
}

async function executeSearchWithProvider(
  provider: string,
  apiKey: string,
  input: z.infer<typeof SearchInput>,
): Promise<SearchResponse> {
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
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    engine: "google",
    q: query,
    num: String(Math.min(maxResults, 20)),
    api_key: apiKey,
  });

  const response = await fetch(
    `https://serpapi.com/search?${params.toString()}`,
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
): Promise<SearchResponse> {
  const response =
    await fetch(
      "https://api.tavily.com/search",
      {
        method: "POST",

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
): Promise<SearchResponse> {
  const response =
    await fetch(
      "https://google.serper.dev/search",
      {
        method: "POST",

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
      "Search the public Internet in real time (moteur cléé si configuré, sinon DuckDuckGo puis Wikipédia).",

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
 * Standalone search helper for server modules (research engine, planners)
 * that need raw results without going through the tool registry.
 */
export async function searchWeb(
  query: string,
  maxResults = 10,
): Promise<SearchResult[]> {
  const parsed =
    SearchInput.parse({ query, maxResults });

  const response =
    await executeSearch(parsed);

  return response.results;
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
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query });
  const response = await fetch(`https://html.duckduckgo.com/html/?${params.toString()}`, {
    headers: {
      "user-agent": BROWSER_UA,
      "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
    },
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
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * API Wikipédia (action=query&list=search) : source toujours disponible,
 * sans clé, avec extraits sourcés. Version française d'abord, anglaise
 * en repli.
 */
export async function searchWikipedia(
  query: string,
  maxResults = 8,
): Promise<SearchResponse> {
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
