/**
 * Client serveur pour l'API 21st.dev (serveur MCP https://21st.dev/api/mcp).
 *
 * L'API est un serveur MCP (JSON-RPC 2.0) authentifie par header `x-api-key`.
 * Outils utilises par Gen3ia :
 *  - `search`        : catalogue (composants/themes/templates), metadata only, illimite
 *  - `get_component` : code source d'un composant (quota — reponse mise en cache Firestore)
 *  - `get_theme`     : tokens CSS d'un theme (quota — cache)
 *  - `search_logo`   : logos SVG (gratuit)
 *  - `get_usage`     : quota du compte
 *
 * La cle vit dans TWENTY_FIRST_API_KEY (env serveur uniquement, jamais cote client).
 */

const MCP_ENDPOINT = "https://21st.dev/api/mcp";

export class TwentyFirstError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "TwentyFirstError";
    this.status = status;
    this.code = code;
  }
}

export interface TwentyFirstUsage {
  tier: string;
  aiGenerationEnabled: boolean;
  freeRetrievalsRemaining: number | null;
  freeRetrievalsPerDay: number | null;
}

interface RpcResult {
  result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
  error?: { code: number; message: string };
}

function apiKey(): string {
  const key = process.env.TWENTY_FIRST_API_KEY;
  if (!key || key.length < 10) {
    throw new TwentyFirstError("Service 21st.dev non configure (TWENTY_FIRST_API_KEY manquante).", 503, "SERVICE_NOT_CONFIGURED");
  }
  return key;
}

function extractText(data: RpcResult): string {
  if (data.error) {
    throw new TwentyFirstError(data.error.message || "Erreur API 21st.dev", 502, `MCP_${data.error.code}`);
  }
  if (data.result?.isError) {
    const text = data.result.content?.map((c) => c.text ?? "").join("\n") ?? "Erreur outil 21st.dev";
    throw new TwentyFirstError(text, 502, "TOOL_ERROR");
  }
  const text = data.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
  if (!text) throw new TwentyFirstError("Reponse 21st.dev vide", 502, "EMPTY_RESPONSE");
  return text;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(MCP_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-api-key": apiKey(),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
      signal: controller.signal,
      cache: "no-store",
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        throw new TwentyFirstError("Cle API 21st.dev refusee.", 502, "UPSTREAM_UNAUTHORIZED");
      }
      if (response.status === 429) {
        throw new TwentyFirstError("Quota 21st.dev atteint. Reessayez demain ou passez sur un plan superieur.", 429, "QUOTA_EXCEEDED");
      }
      throw new TwentyFirstError(`Erreur 21st.dev (${response.status}) ${bodyText.slice(0, 200)}`, 502, "UPSTREAM_ERROR");
    }

    if (contentType.includes("text/event-stream")) {
      const raw = await response.text();
      const dataLine = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .pop();
      if (!dataLine) throw new TwentyFirstError("Flux 21st.dev illisible", 502, "SSE_PARSE_ERROR");
      return extractText(JSON.parse(dataLine) as RpcResult);
    }

    return extractText((await response.json()) as RpcResult);
  } catch (error) {
    if (error instanceof TwentyFirstError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new TwentyFirstError("Timeout 21st.dev", 504, "UPSTREAM_TIMEOUT");
    }
    throw new TwentyFirstError(error instanceof Error ? error.message : "Erreur reseau 21st.dev", 502, "NETWORK_ERROR");
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Types de catalogues
// ---------------------------------------------------------------------------

export interface CatalogResult {
  kind: "component" | "theme" | "template" | "other";
  id: string;
  name: string;
  author: string;
  description: string;
  previewUrl: string | null;
  pageUrl: string | null;
  installCommand: string | null;
}

function parseCatalog(raw: string): CatalogResult[] {
  const results: CatalogResult[] = [];
  const blocks = raw.split(/\n(?=### \[)/g);
  for (const block of blocks) {
    const kindMatch = block.match(/^### \[(\w+)\]/);
    if (!kindMatch) continue;
    const kindRaw = kindMatch[1].toLowerCase();
    const kind: CatalogResult["kind"] =
      kindRaw === "component" ? "component" : kindRaw === "theme" ? "theme" : kindRaw === "template" ? "template" : "other";
    const title = block.match(/^### \[\w+\]\s*(.+?)\s*(?:\[id:\s*(\d+)\])?\s*$/m);
    const idMatch = block.match(/\[id:\s*(\d+)\]/);
    if (!idMatch) continue;
    const authorMatch = block.match(/^by\s+(.+)$/m);
    const previewMatch = block.match(/preview:\s*(https?:\/\/\S+)/);
    const pageMatch = block.match(/page:\s*(https?:\/\/\S+)/);
    const installMatch = block.match(/install:\s*(.+)$/m);
    const descriptionLines: string[] = [];
    for (const line of block.split("\n")) {
      if (
        /^### \[/.test(line) ||
        /^by\s+/.test(line) ||
        /^(preview|page|install|demo|→)/.test(line) ||
        /^\d+ result/.test(line)
      ) {
        continue;
      }
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("```")) descriptionLines.push(trimmed);
    }
    results.push({
      kind,
      id: idMatch[1],
      name: title?.[1]?.trim() ?? `Item ${idMatch[1]}`,
      author: authorMatch?.[1]?.trim() ?? "21st.dev",
      description: descriptionLines.join(" ").slice(0, 400),
      previewUrl: previewMatch?.[1] ?? null,
      pageUrl: pageMatch?.[1] ?? null,
      installCommand: installMatch?.[1]?.trim() ?? null,
    });
  }
  return results;
}

export async function searchCatalog(query: string, limit = 8): Promise<CatalogResult[]> {
  const raw = await callTool("search", { query, limit: Math.min(Math.max(limit, 1), 16) });
  return parseCatalog(raw);
}

// ---------------------------------------------------------------------------
// Composant : code source + demo
// ---------------------------------------------------------------------------

export interface ComponentCode {
  id: string;
  name: string;
  installCommand: string | null;
  code: string | null;
  demo: string | null;
  dependencies: string[];
}

function parseComponent(raw: string, id: string): ComponentCode {
  const nameMatch = raw.match(/^#\s+(.+)$/m);
  const installMatch = raw.match(/install:\s*(.+)$/m);
  const depsMatch = raw.match(/(?:registryDependencies|dependencies):\s*([^\n]+)/m);

  const codeBlocks: string[] = [];
  const demoBlocks: string[] = [];
  const sections = raw.split(/^## /gm);
  for (const section of sections) {
    const blocks = [...section.matchAll(/```(?:tsx?|jsx?|css)?\n([\s\S]*?)```/g)].map((m) => m[1]);
    if (blocks.length === 0) continue;
    if (/^Component/i.test(section)) codeBlocks.push(...blocks);
    else if (/^(?:demo|usage|example)/i.test(section)) demoBlocks.push(...blocks);
    else codeBlocks.push(...blocks);
  }

  return {
    id,
    name: nameMatch?.[1]?.replace(/—.*$/, "").trim() ?? `Component ${id}`,
    installCommand: installMatch?.[1]?.trim() ?? null,
    code: codeBlocks.join("\n\n") || null,
    demo: demoBlocks.join("\n\n") || null,
    dependencies: depsMatch ? depsMatch[1].split(",").map((d) => d.trim()).filter(Boolean).slice(0, 20) : [],
  };
}

export async function getComponent(id: string): Promise<ComponentCode> {
  if (!/^\d{1,10}$/.test(id)) throw new TwentyFirstError("Identifiant de composant invalide.", 400, "INVALID_ID");
  const raw = await callTool("get_component", { id: Number(id) });
  // En plan gratuit, l'outil repond avec un message de succes (pas une erreur
  // MCP) lorsque le quota quotidien est epuise : on le transforme en erreur 429.
  if (/reached the free 21st component-code limit/i.test(raw)) {
    throw new TwentyFirstError(
      "Quota 21st.dev atteint (2 recuperations de code par jour en plan gratuit, remise a zero a minuit UTC). Les composants deja recuperes restent servis depuis le cache.",
      429,
      "QUOTA_EXCEEDED",
    );
  }
  const parsed = parseComponent(raw, id);
  if (!parsed.code) {
    throw new TwentyFirstError("Code du composant indisponible chez 21st.dev.", 502, "EMPTY_COMPONENT");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Theme : tokens CSS
// ---------------------------------------------------------------------------

export interface ThemeTokens {
  id: string;
  name: string;
  css: string | null;
  pageUrl: string | null;
}

export async function getTheme(id: string): Promise<ThemeTokens> {
  if (!/^\d{1,10}$/.test(id)) throw new TwentyFirstError("Identifiant de theme invalide.", 400, "INVALID_ID");
  const raw = await callTool("get_theme", { id: Number(id) });
  const nameMatch = raw.match(/name:\s*(.+)/i) ?? raw.match(/^#\s+(.+)$/m);
  const cssMatch = raw.match(/```css\n([\s\S]*?)```/);
  const pageMatch = raw.match(/page:\s*(https?:\/\/\S+)/);
  return {
    id,
    name: nameMatch?.[1]?.trim() ?? `Theme ${id}`,
    css: cssMatch?.[1] ?? raw,
    pageUrl: pageMatch?.[1] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Logos (gratuit) + usage
// ---------------------------------------------------------------------------

export interface LogoResult {
  title: string;
  svgUrl: string | null;
  category: string | null;
}

export async function searchLogos(query: string): Promise<LogoResult[]> {
  const raw = await callTool("search_logo", { query: query.slice(0, 80) });
  const logos: LogoResult[] = [];
  const blocks = raw.split(/\n(?=#{1,3}\s|\[)/g);
  for (const block of blocks) {
    const titleMatch = block.match(/(?:^#{1,3}\s+|\[)"?([^\]"\n]{1,60})"?\]?/);
    if (!titleMatch) continue;
    const svgMatch = block.match(/(https?:\/\/\S+\.svg\S*)/i) ?? block.match(/(https?:\/\/[^\s)]*svgl[^\s)]*)/i);
    const categoryMatch = block.match(/category:\s*([^\n]+)/i);
    logos.push({
      title: titleMatch[1].trim(),
      svgUrl: svgMatch?.[1] ?? null,
      category: categoryMatch?.[1]?.trim() ?? null,
    });
  }
  return logos.slice(0, 12);
}

export async function getUsage(): Promise<TwentyFirstUsage> {
  const raw = await callTool("get_usage", {});
  const tier = raw.match(/Tier:\s*(\w+)/)?.[1] ?? "unknown";
  const aiEnabled = /aiGenerationEnabled"?\s*:\s*true/.test(raw) || /21st AI generation:\s*enabled/.test(raw);
  const remaining = raw.match(/([\d]+)\/([\d]+) remaining/i) ?? raw.match(/retrievals:\s*(\d+)\/(\d+)/i);
  return {
    tier,
    aiGenerationEnabled: aiEnabled,
    freeRetrievalsRemaining: remaining ? Number(remaining[1]) : null,
    freeRetrievalsPerDay: remaining ? Number(remaining[2]) : null,
  };
}
