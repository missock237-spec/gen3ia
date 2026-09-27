import { z } from "zod";

import { assertPublicHttpUrl } from "@/lib/security/url-safety";
import type { ToolDefinition } from "../types";

/**
 * Outils « API directe » : les agents peuvent appeler N'IMPORTE QUELLE API
 * publique désignée par URL — sans connecteur préalable. L'appel est exécuté
 * RÉELLEMENT par le serveur et la réponse réelle est restituée (statut + corps,
 * JSON parsé si applicable). Lecture (GET) directe ; toute écriture
 * (POST/PUT/PATCH/DELETE) est sensible et passe par la validation humaine.
 *
 * Sécurité : garde SSRF (aucune adresse interne/privée), redirections
 * revalidées, délai 25 s, corps tronqué, réponse non-2xx restituée telle
 * quelle (jamais de donnée inventée).
 */

const WEB_API_TIMEOUT_MS = 25_000;
/** Corps restitué au modèle (les réponses API peuvent être énormes). */
export const WEB_API_MAX_BODY_CHARS = 100_000;
const MAX_REDIRECTS = 2;

const queryHeadersSchema = z.record(z.string().min(1).max(200), z.string().max(2000));
const limitedQuery = queryHeadersSchema.refine((v) => Object.keys(v).length <= 20, "20 paramètres maximum");
const limitedHeaders = queryHeadersSchema.refine((v) => Object.keys(v).length <= 10, "10 en-têtes maximum");

const ReadInputSchema = z.object({
  url: z.string().trim().url().max(2000),
  query: limitedQuery.optional(),
  headers: limitedHeaders.optional(),
});

const WriteInputSchema = ReadInputSchema.extend({
  method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
  body: z.union([z.string().max(WEB_API_MAX_BODY_CHARS), z.record(z.string(), z.unknown())]).optional(),
});

export interface WebApiCallOutput {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  contentType?: string;
  /** Corps réel tronqué (texte ou JSON sérialisé). */
  body?: string;
  /** JSON parsé si le contenu est de type application/json. */
  json?: unknown;
  latencyMs: number;
}

export class WebApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebApiError";
  }
}

function truncate(value: string): string {
  if (value.length <= WEB_API_MAX_BODY_CHARS) return value;
  return `${value.slice(0, WEB_API_MAX_BODY_CHARS)}\n… (corps tronqué, ${value.length - WEB_API_MAX_BODY_CHARS} caractères restants)`;
}

/** Construit l'URL finale (query fusionné) puis applique la garde SSRF. */
async function buildUrl(rawUrl: string, query?: Record<string, string>): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebApiError(`URL invalide : ${rawUrl}`);
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (key.trim()) url.searchParams.set(key.trim(), value);
  }
  try {
    await assertPublicHttpUrl(url.toString());
  } catch (error) {
    throw new WebApiError(`URL non autorisée (${url.toString()}) : ${error instanceof Error ? error.message : "erreur"}`);
  }
  return url;
}

async function fetchWithGuardedRedirects(url: URL, init: RequestInit): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, {
      ...init,
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(WEB_API_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new WebApiError("L'API a renvoyé une redirection sans destination.");
      if (hop === MAX_REDIRECTS) throw new WebApiError(`Trop de redirections (${MAX_REDIRECTS + 1} maximum).`);
      current = await buildUrl(new URL(location, current).toString());
      continue;
    }
    return response;
  }
  throw new WebApiError("Boucle de redirections non résolue.");
}

/** Exécution réelle partagée (lecture comme écriture). */
async function executeApiCall(
  input: { url: string; query?: Record<string, string>; headers?: Record<string, string> },
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  body?: string | Record<string, unknown>,
): Promise<WebApiCallOutput> {
  const url = await buildUrl(input.url, input.query);
  const headers: Record<string, string> = { accept: "application/json, text/*;q=0.9, */*;q=0.8" };
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (key.trim()) headers[key.trim().toLowerCase()] = value;
  }
  const hasBody = method !== "GET" && method !== "DELETE" && body !== undefined && body !== null;
  if (hasBody && !headers["content-type"]) headers["content-type"] = "application/json";

  const startedAt = Date.now();
  try {
    const response = await fetchWithGuardedRedirects(url, {
      method,
      headers,
      ...(hasBody ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const contentType = response.headers.get("content-type")?.split(";")[0].trim() ?? undefined;
    const rawBody = (await response.text()).slice(0, WEB_API_MAX_BODY_CHARS + 1_000);
    const latencyMs = Date.now() - startedAt;
    let json: unknown;
    if (contentType?.includes("json")) {
      try {
        json = JSON.parse(rawBody);
      } catch {
        /* corps JSON invalide : la version texte reste disponible */
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: url.toString(),
      ...(contentType ? { contentType } : {}),
      body: truncate(rawBody),
      ...(json !== undefined ? { json } : {}),
      latencyMs,
    };
  } catch (error) {
    if (error instanceof WebApiError) throw error;
    const reason =
      error instanceof Error && /timeout|aborted/i.test(error.message)
        ? `délai dépassé (${Math.round(WEB_API_TIMEOUT_MS / 1000)} s)`
        : error instanceof Error
          ? error.message
          : "erreur réseau";
    throw new WebApiError(`L'appel réel (${method} ${url.toString()}) a échoué : ${reason}`);
  }
}

export const webApiTool: ToolDefinition<z.infer<typeof ReadInputSchema>, WebApiCallOutput> = {
  name: "web.api",
  description:
    "Appelle RÉELLEMENT une API publique désignée par URL (GET) et retourne la réponse réelle (statut + corps, JSON parsé). " +
    "Input : { url: \"https://…\", query?: {…}, headers?: {…} }. " +
    "À utiliser quand l'utilisateur donne l'URL d'une API à interroger ou demande d'appeler une API.",
  category: "http",
  risk: "medium",
  inputSchema: ReadInputSchema,
  async execute(input) {
    return executeApiCall(input, "GET");
  },
};

export const webApiWriteTool: ToolDefinition<z.infer<typeof WriteInputSchema>, WebApiCallOutput> = {
  name: "web.api.write",
  description:
    "Modifie RÉELLEMENT des données dans une API publique désignée par URL (POST/PUT/PATCH/DELETE — action externe soumise à validation humaine). " +
    "Input : { url: \"https://…\", method: \"POST\"|\"PUT\"|\"PATCH\"|\"DELETE\", body?: string|objet, query?: {…}, headers?: {…} }.",
  category: "http",
  risk: "high",
  inputSchema: WriteInputSchema,
  async execute(input) {
    const { method, body, ...rest } = input;
    return executeApiCall(rest, method, body);
  },
};
