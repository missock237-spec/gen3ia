import "server-only";

import { assertPublicHttpUrl } from "@/lib/security/url-safety";
import {
  findCustomApiByName,
  getCustomApi,
  listCustomApis,
  touchCustomApiCall,
  type CustomApiRecord,
} from "./repository";

/**
 * Appel RÉEL d'une API personnelle : requête HTTP serveur vers l'API
 * déclarée par l'utilisateur, avec son authentification, et restitution
 * brute du résultat réel (statut + corps) — jamais de donnée inventée.
 */

export const CUSTOM_API_TIMEOUT_MS = 25_000;
/** Corps restitué au modèle (les réponses API peuvent être énormes). */
export const CUSTOM_API_MAX_BODY_CHARS = 100_000;

export type CustomApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CustomApiCallInput {
  apiId?: string;
  apiName?: string;
  method?: CustomApiMethod;
  /** Chemin ajouté à l'URL de base (ex. « /users/1 »). */
  path?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** Corps de la requête (custom_api.write uniquement). */
  body?: string | Record<string, unknown>;
}

export interface CustomApiCallOutput {
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
  api: { id: string; name: string };
}

export class CustomApiError extends Error {
  constructor(
    message: string,
    readonly detail?: { status?: number; body?: string },
  ) {
    super(message);
    this.name = "CustomApiError";
  }
}

/** Réunit l'URL de base et le chemin en évitant doubles/fameux slashs manquants. */
export function joinApiUrl(baseUrl: string, path?: string, query?: Record<string, string>): URL {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = (path ?? "").replace(/^\/+/, "");
  const url = new URL(suffix ? `${base}/${suffix}` : base);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (key.trim()) url.searchParams.set(key.trim(), value);
  }
  return url;
}

/** En-têtes d'authentification réels déduits de la configuration de l'API. */
export function buildAuthHeaders(api: CustomApiRecord, extraHeaders?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json, text/*;q=0.9, */*;q=0.8" };
  if (api.authType === "bearer" && api.authValue) headers.authorization = `Bearer ${api.authValue}`;
  if (api.authType === "header" && api.authValue) headers[(api.authHeader ?? "Authorization").toLowerCase()] = api.authValue;
  for (const [key, value] of Object.entries(extraHeaders ?? {})) {
    if (key.trim()) headers[key.trim().toLowerCase()] = value;
  }
  return headers;
}

/** Ajoute le secret en paramètre d'URL (authType=query). */
export function applyQueryAuth(api: CustomApiRecord, url: URL): URL {
  if (api.authType === "query" && api.authValue && api.queryKey) {
    url.searchParams.set(api.queryKey, api.authValue);
  }
  return url;
}

/** Résout l'API ciblée : par id, puis par nom, puis unique API activée. */
export async function resolveCustomApi(
  userId: string,
  input: Pick<CustomApiCallInput, "apiId" | "apiName">,
): Promise<CustomApiRecord> {
  if (input.apiId) {
    const byId = await getCustomApi(userId, input.apiId);
    if (byId) {
      if (!byId.enabled) throw new CustomApiError(`L'API « ${byId.name} » est désactivée. Activez-la depuis Intégrations pour l'utiliser.`);
      return byId;
    }
  }
  if (input.apiName?.trim()) {
    const byName = await findCustomApiByName(userId, input.apiName);
    if (byName) {
      if (!byName.enabled) throw new CustomApiError(`L'API « ${byName.name} » est désactivée. Activez-la depuis Intégrations pour l'utiliser.`);
      return byName;
    }
    const all = await listCustomApis(userId);
    throw new CustomApiError(
      all.length === 0
        ? "Aucune API personnelle n'est enregistrée. Fournissez une API dans le chat (ex. « connecte cette API : https://… avec la clé … ») ou depuis la page Intégrations."
        : `API « ${input.apiName} » introuvable. Vos API personnelles : ${all.map((api) => `« ${api.name} »`).join(", ")}.`,
    );
  }
  const all = await listCustomApis(userId);
  const enabled = all.filter((api) => api.enabled);
  if (enabled.length === 1) return enabled[0];
  if (enabled.length === 0) {
    throw new CustomApiError(
      all.length === 0
        ? "Aucune API personnelle n'est enregistrée. Fournissez une API dans le chat (ex. « connecte cette API : https://… avec la clé … ») ou depuis la page Intégrations."
        : "Plusieurs API personnelles existent mais aucune n'est activée. Activez-en une depuis Intégrations.",
    );
  }
  throw new CustomApiError(
    `Plusieurs API personnelles sont disponibles : ${enabled.map((api) => `« ${api.name} »`).join(", ")}. Précisez laquelle utiliser (apiName).`,
  );
}

function truncate(value: string): string {
  if (value.length <= CUSTOM_API_MAX_BODY_CHARS) return value;
  return `${value.slice(0, CUSTOM_API_MAX_BODY_CHARS)}\n… (corps tronqué, ${value.length - CUSTOM_API_MAX_BODY_CHARS} caractères restants)`;
}

/**
 * Exécute l'appel HTTP réel vers l'API personnelle de l'utilisateur.
 * Le résultat est TOUJOURS la réponse réelle de l'API (ou l'erreur réelle) —
 * une réponse non-2xx est restituée telle quelle (statut + corps) plutôt
 * que masquée, pour que le modèle décrive ce qui s'est réellement passé.
 */
export async function executeCustomApiCall(userId: string, input: CustomApiCallInput): Promise<CustomApiCallOutput> {
  const api = await resolveCustomApi(userId, input);
  const method = input.method ?? "GET";

  let url: URL;
  try {
    url = applyQueryAuth(api, joinApiUrl(api.baseUrl, input.path, input.query));
    // Garde SSRF : l'API appartient à l'utilisateur, mais aucun appel vers
    // les adresses internes/privées de l'infrastructure n'est autorisé.
    await assertPublicHttpUrl(url.toString());
  } catch (error) {
    throw new CustomApiError(
      `URL d'API invalide ou non autorisée (${api.baseUrl}) : ${error instanceof Error ? error.message : "erreur"}`,
    );
  }

  const headers = buildAuthHeaders(api, input.headers);
  const hasBody = method !== "GET" && method !== "DELETE" && input.body !== undefined && input.body !== null;
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method,
      headers: hasBody && !headers["content-type"] ? { ...headers, "content-type": "application/json" } : headers,
      ...(hasBody ? { body: typeof input.body === "string" ? input.body : JSON.stringify(input.body) } : {}),
      signal: AbortSignal.timeout(CUSTOM_API_TIMEOUT_MS),
      redirect: "follow",
    });

    const contentType = response.headers.get("content-type")?.split(";")[0].trim() ?? undefined;
    const rawBody = (await response.text()).slice(0, CUSTOM_API_MAX_BODY_CHARS + 1_000);
    const latencyMs = Date.now() - startedAt;

    let json: unknown;
    if (contentType?.includes("json")) {
      try {
        json = JSON.parse(rawBody);
      } catch {
        /* corps JSON invalide : la version texte reste disponible */
      }
    }

    void touchCustomApiCall(api.id, response.ok ? "success" : "failed", response.status);

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: url.toString(),
      ...(contentType ? { contentType } : {}),
      body: truncate(rawBody),
      ...(json !== undefined ? { json } : {}),
      latencyMs,
      api: { id: api.id, name: api.name },
    };
  } catch (error) {
    void touchCustomApiCall(api.id, "failed");
    const reason =
      error instanceof Error && /timeout|aborted/i.test(error.message)
        ? `délai dépassé (${Math.round(CUSTOM_API_TIMEOUT_MS / 1000)} s)`
        : error instanceof Error
          ? error.message
          : "erreur réseau";
    throw new CustomApiError(`L'appel réel vers « ${api.name} » (${method} ${url.toString()}) a échoué : ${reason}`);
  }
}
