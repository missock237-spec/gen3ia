import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";

/**
 * OUTIL AGENT « registry.find » — Live MCP Tool Finder (Task 140).
 *
 * Connexion EN DIRECT aux registres de packages (npm + PyPI) pour que
 * l'agent RECHERCHE / COMPARE / VÉRIFIE l'existence et la fraîcheur d'une
 * bibliothèque AVANT de la recommander ou de l'installer — plus jamais de
 * paquet obsolète, déprécié ou inexistant recommandé à un utilisateur.
 *
 * 100 % DÉTERMINISTE — AUCUN appel LLM : recherche npm (API de recherche
 * publique), détails npm par paquet (version, date de publication,
 * dépréciation), vérification exacte PyPI. Réponse rapide, facturation
 * nulle, résultats reproductibles.
 *
 * HONNÊTETÉ SUR LES LIMITES : PyPI n'expose AUCUNE API de recherche
 * publique stable — côté PyPI, l'outil ne peut donc que VÉRIFIER un nom
 * de paquet connu/exact (existence + version + résumé). En écosystème
 * « auto », si la recherche npm renvoie moins de 2 candidats, la vérification
 * PyPI du nom exact est tentée en complément.
 *
 * Sécurité réseau : fetch avec timeout 10 s, corps plafonné à 2 Mo, URLs
 * construites par encodeURIComponent. Timeout/réseau/5xx → erreur FRANÇAISE
 * explicite, jamais de résultat factice silencieux.
 */

const NPM_SEARCH_URL = "https://registry.npmjs.org/-/v1/search";
const NPM_PACKAGE_URL = "https://registry.npmjs.org";
const PYPI_PACKAGE_URL = "https://pypi.org/pypi";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const inputSchema = z.object({
  query: z.string().min(2).max(200),
  ecosystem: z.enum(["npm", "pypi", "auto"]).default("auto"),
  verifyOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(10).default(5),
});

export interface RegistryFindResultItem {
  name: string;
  ecosystem: "npm" | "pypi";
  exists: boolean;
  latestVersion?: string;
  deprecated?: boolean;
  deprecationMessage?: string;
  lastPublished?: string;
  ageDays?: number;
  description?: string;
  keywords?: string[];
  isMcpServer: boolean;
  searchScore?: number;
  verdict: string;
}

export interface RegistryFindResult {
  ecosystem: "npm" | "pypi" | "auto";
  query: string;
  verifyOnly: boolean;
  results: RegistryFindResultItem[];
  recommendation: string;
}

interface NpmSearchCandidate {
  name: string;
  description?: string;
  keywords?: string[];
  searchScore?: number;
}

/** Lecture JSON bornée (timeout + taille) avec erreur française dédiée au registre. */
async function fetchJson(
  url: string,
  registryLabel: string,
  options?: { allowNotFound?: boolean },
): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Registre ${registryLabel} inaccessible : ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 404 && options?.allowNotFound) return null;
  if (!response.ok) {
    throw new Error(`Registre ${registryLabel} inaccessible : statut HTTP ${response.status} pour ${url}`);
  }
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    throw new Error(
      `Registre ${registryLabel} inaccessible : lecture du corps impossible (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new Error(`Réponse du registre ${registryLabel} trop volumineuse (dépasse 2 Mo) — requête abandonnée.`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`Réponse du registre ${registryLabel} illisible (JSON invalide).`);
  }
}

/** Un résultat est-il un serveur MCP ? (préfixe officiel ou mots-clés déclarés) */
export function isMcpServerPackage(name: string, keywords?: string[]): boolean {
  if (name.startsWith("@modelcontextprotocol/")) return true;
  const normalized = (keywords ?? []).map((keyword) => keyword.toLowerCase());
  return normalized.includes("mcp") || normalized.includes("model-context-protocol");
}

/** Verdict de fraîcheur déterministe (français). */
export function freshnessVerdict(deprecated: boolean, ageDays?: number): string {
  if (deprecated) return "déprécié — à éviter";
  if (ageDays === undefined) return "à jour"; // date inconnue : pas de signal de vieillesse.
  if (ageDays > 730) return "obsolète";
  if (ageDays >= 365) return "à surveiller";
  return "à jour";
}

function computeAgeDays(published: string | undefined): number | undefined {
  if (!published) return undefined;
  const parsed = Date.parse(published);
  if (Number.isNaN(parsed)) return undefined;
  return Math.max(0, Math.floor((Date.now() - parsed) / 86_400_000));
}

async function npmSearchCandidates(query: string, limit: number): Promise<NpmSearchCandidate[]> {
  const size = Math.min(25, limit * 3);
  const url = `${NPM_SEARCH_URL}?text=${encodeURIComponent(query)}&size=${size}`;
  const payload = (await fetchJson(url, "npm")) as {
    objects?: Array<{
      package?: { name?: string; description?: string; keywords?: string[] };
      score?: { final?: number };
    }>;
  } | null;
  const objects = payload?.objects ?? [];
  return objects
    .filter((object) => typeof object.package?.name === "string")
    .map((object) => ({
      name: object.package?.name as string,
      description: object.package?.description,
      keywords: Array.isArray(object.package?.keywords)
        ? (object.package?.keywords as string[])
        : undefined,
      searchScore: typeof object.score?.final === "number" ? object.score.final : undefined,
    }))
    .sort((a, b) => (b.searchScore ?? 0) - (a.searchScore ?? 0));
}

/** Détails npm (version, date de publication, dépréciation) — nom exact. */
async function npmDetails(candidate: NpmSearchCandidate): Promise<RegistryFindResultItem> {
  const url = `${NPM_PACKAGE_URL}/${encodeURIComponent(candidate.name)}`;
  const payload = (await fetchJson(url, "npm", { allowNotFound: true })) as {
    "dist-tags"?: { latest?: string };
    time?: Record<string, string>;
    versions?: Record<string, { deprecated?: string | boolean }>;
    description?: string;
  } | null;

  if (!payload) {
    return {
      name: candidate.name,
      ecosystem: "npm",
      exists: false,
      isMcpServer: isMcpServerPackage(candidate.name, candidate.keywords),
      searchScore: candidate.searchScore,
      verdict: "introuvable",
    };
  }
  const latest = payload["dist-tags"]?.latest;
  const lastPublished = latest ? payload.time?.[latest] : undefined;
  const deprecatedEntry = latest ? payload.versions?.[latest]?.deprecated : undefined;
  const deprecated = typeof deprecatedEntry === "string" && deprecatedEntry.length > 0;
  const ageDays = computeAgeDays(lastPublished);
  return {
    name: candidate.name,
    ecosystem: "npm",
    exists: true,
    latestVersion: latest,
    deprecated,
    deprecationMessage: deprecated ? (deprecatedEntry as string) : undefined,
    lastPublished,
    ageDays,
    description: candidate.description ?? payload.description,
    keywords: candidate.keywords?.slice(0, 8),
    isMcpServer: isMcpServerPackage(candidate.name, candidate.keywords),
    searchScore: candidate.searchScore,
    verdict: freshnessVerdict(deprecated, ageDays),
  };
}

/** Vérification PyPI d'un nom exact (aucune API de recherche publique — voir docblock). */
async function pypiCheck(name: string): Promise<RegistryFindResultItem> {
  const url = `${PYPI_PACKAGE_URL}/${encodeURIComponent(name)}/json`;
  const payload = (await fetchJson(url, "PyPI", { allowNotFound: true })) as {
    info?: { version?: string; summary?: string; home_page?: string };
  } | null;
  if (!payload?.info) {
    return {
      name,
      ecosystem: "pypi",
      exists: false,
      isMcpServer: isMcpServerPackage(name),
      verdict: "introuvable",
    };
  }
  return {
    name,
    ecosystem: "pypi",
    exists: true,
    latestVersion: payload.info.version,
    description: payload.info.summary,
    isMcpServer: isMcpServerPackage(name),
    verdict: freshnessVerdict(false, undefined),
  };
}

function buildRecommendation(query: string, results: RegistryFindResultItem[]): string {
  const existing = results.filter((item) => item.exists);
  if (existing.length === 0) {
    return `Aucun paquet nommé « ${query} » n'a été trouvé sur les registres interrogés — vérifiez l'orthographe ou changez d'écosystème.`;
  }
  const deprecatedNames = existing.filter((item) => item.deprecated).map((item) => item.name);
  const freshest = existing
    .filter((item) => !item.deprecated)
    .sort((a, b) => (a.ageDays ?? Number.MAX_SAFE_INTEGER) - (b.ageDays ?? Number.MAX_SAFE_INTEGER))[0];

  const parts: string[] = [];
  if (freshest) {
    const version = freshest.latestVersion ? `v${freshest.latestVersion}` : "version inconnue";
    const freshness =
      freshest.ageDays !== undefined ? `, publié il y a ${freshest.ageDays} jour(s)` : "";
    parts.push(
      `Recommandation : « ${freshest.name} » (${freshest.ecosystem}, ${version}${freshness}) est le résultat le plus frais.`,
    );
    if (freshest.isMcpServer) parts.push("Ce paquet est identifié comme serveur MCP.");
  } else {
    parts.push("Tous les paquets trouvés sont dépréciés — aucun paquet recommandable, cherchez une alternative active.");
  }
  if (deprecatedNames.length > 0) {
    const plural = deprecatedNames.length > 1;
    parts.push(
      `Attention : ${deprecatedNames.map((name) => `« ${name} »`).join(", ")} ${plural ? "sont" : "est"} déprécié${plural ? "s" : ""} — à éviter.`,
    );
  }
  return parts.join(" ");
}

export const registryFindTool: ToolDefinition<z.infer<typeof inputSchema>, RegistryFindResult> = {
  id: "registry.find",
  name: "Live MCP Tool Finder",
  description:
    "Query the npm and PyPI package registries LIVE (no LLM, fully deterministic): search, compare and verify that a library exists and how fresh it is (latest version, publish date, deprecation, MCP server detection) before recommending or installing it. PyPI has no public search API — only exact-name verification there.",
  category: "mcp",
  risk: "low",
  inputSchema,
  async execute(input) {
    const parsed = inputSchema.parse(input);
    const results: RegistryFindResultItem[] = [];

    if (parsed.ecosystem === "pypi") {
      // PyPI : vérification du nom exact uniquement (aucune recherche publique).
      results.push(await pypiCheck(parsed.query));
    } else if (parsed.verifyOnly) {
      const npmExact = await npmDetails({ name: parsed.query });
      results.push(npmExact);
      if (parsed.ecosystem === "auto" && !npmExact.exists) {
        results.push(await pypiCheck(parsed.query));
      }
    } else {
      const candidates = await npmSearchCandidates(parsed.query, parsed.limit);
      for (const candidate of candidates.slice(0, parsed.limit)) {
        results.push(await npmDetails(candidate));
      }
      if (parsed.ecosystem === "auto" && candidates.length < 2) {
        results.push(await pypiCheck(parsed.query));
      }
    }

    return {
      ecosystem: parsed.ecosystem,
      query: parsed.query,
      verifyOnly: parsed.verifyOnly,
      results,
      recommendation: buildRecommendation(parsed.query, results),
    };
  },
};
