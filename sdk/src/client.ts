/**
 * Client SDK Gen3ia (@gen3ia/sdk).
 *
 * ZÉRO dépendance runtime : `fetch` global (Node >= 20, tous navigateurs
 * modernes), `AbortSignal.timeout`, `ReadableStream`. Injectable via
 * `fetch` pour les tests et les proxies.
 *
 * Trois modes d'authentification, à choisir selon la surface utilisée :
 *  - CLÉ DÉVELOPPEUR (`apiKey` + `projectId`) : exécution d'agents
 *    personnalisés via /api/v1 — backends, n8n, scripts serveur ;
 *  - TOKEN FIREBASE (`firebaseToken`, statique ou fournisseur async) :
 *    missions longues avec file de ticks R2 (202 + runId + SSE) — l'appelant est
 *    l'utilisateur lui-même (CLI, app mobile) ;
 *  - SANS AUTH : santé, agents publics, salons commerciaux.
 *
 * Politique de retry : SEULS les GET sont retentés (erreurs réseau et
 * 502/503/504) — un POST n'est JAMAIS retenté automatiquement, car
 * ré-exécuter une mission facturée doublerait la facture.
 */

import {
  Gen3iaApiError,
  Gen3iaConfigurationError,
  Gen3iaError,
  Gen3iaNetworkError,
  Gen3iaTimeoutError,
  messageFromErrorBody,
} from "./errors.js";
import { createSseParser } from "./sse.js";
import type {
  AgentRunResult,
  CommercialChatInput,
  CommercialChatResult,
  CommercialSalonInfo,
  HealthInfo,
  MissionFinalEvent,
  MissionProgressEvent,
  MissionQueued,
  MissionRunResult,
  MissionRunStatus,
  PublicAgentChatResult,
  PublicAgentInfo,
  RunMissionInput,
  WebhookTriggerResult,
} from "./types.js";

const DEFAULT_BASE_URL = "https://gen3ia.online";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
/** Un run /api/v1 peut durer jusqu'à 300 s côté serveur (maxDuration). */
const AGENT_RUN_TIMEOUT_MS = 320_000;

/**
 * Retire les slashs terminaux d'une URL de base SANS expression régulière.
 *
 * CodeQL js/polynomial-redos (alerte #53) : l'ancienne normalisation par
 * expression régulière (« un ou plusieurs slashs en fin de chaîne ») sur une
 * donnée non contrôlée (`options.baseUrl` vient du code appelant / de la
 * configuration) est classée polynomial (backtracking sur de longues
 * répétitions de « / »). La boucle `endsWith` + `slice` ci-dessous est
 * strictement LINÉAIRE O(n) : aucun backtracking possible.
 */
export function trimTrailingSlashes(url: string): string {
  let base = url;
  while (base.endsWith("/")) base = base.slice(0, -1);
  return base;
}

export interface Gen3iaClientOptions {
  /** Origine de l'API — défaut https://gen3ia.online. */
  baseUrl?: string;
  /** Clé API développeur (g3x_…) — requise pour `agents.run`. */
  apiKey?: string;
  /** Projet Gen3ia lié à la clé — requis pour `agents.run` (X-Gen3ia-Project-Id). */
  projectId?: string;
  /**
   * Token ID Firebase de session — requis pour `missions.*`. Accepte une
   * chaîne statique OU un fournisseur (sync/async) pour les tokens
   * de courte durée : le fournisseur est résolu à CHAQUE requête.
   */
  firebaseToken?: string | (() => string | Promise<string>);
  /** Implémentation fetch injectable (tests, proxies). Défaut : globalThis.fetch. */
  fetch?: typeof fetch;
  /** Délai d'expiration par requête (ms) — défaut 60 000. */
  timeoutMs?: number;
  /** Retentissements GET sur erreur transitoire — défaut 2. */
  maxRetries?: number;
  /** Base du backoff exponentiel GET (ms) — défaut 250. */
  retryBaseDelayMs?: number;
}

type AuthMode = "developer" | "session" | "none";

interface RequestOptions {
  auth: AuthMode;
  body?: unknown;
  signal?: AbortSignal;
  /** ms — undefined = timeout par défaut du client. */
  timeoutMs?: number;
  accept?: string;
  retryable?: boolean;
}

interface RequestResult<T> {
  data: T;
  response: Response;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff exponentiel avec gigue — évite les tempêtes de reconnexions. */
function backoffDelay(baseMs: number, attempt: number): number {
  const jitter = Math.floor(Math.random() * 120);
  return baseMs * 2 ** attempt + jitter;
}

/** Compose le signal appelant avec un timeout, sans le muter. */
function combinedSignal(timeoutMs: number | undefined, signal: AbortSignal | undefined): AbortSignal | undefined {
  const timeout = timeoutMs === undefined || timeoutMs <= 0 ? undefined : AbortSignal.timeout(timeoutMs);
  if (timeout && signal) return AbortSignal.any([timeout, signal]);
  return timeout ?? signal ?? undefined;
}

export interface MissionStreamHandlers {
  onProgress?: (event: MissionProgressEvent) => void;
  onFinal?: (event: MissionFinalEvent) => void;
  onError?: (error: unknown) => void;
}

export interface MissionStreamHandle {
  /** Ferme la connexion immédiatement (idempotent). */
  close(): void;
  /** Résolu quand la connexion est terminée (final, fermeture serveur ou close()). */
  done: Promise<void>;
}

export interface MissionFollowOptions {
  signal?: AbortSignal;
  /** Garde-fou absolu (ms) — dépassé, le suivi s'arrête avec Gen3iaTimeoutError. */
  maxDurationMs?: number;
  /** Délai avant reconnexion après une fenêtre serveur (ms) — défaut 500. */
  reconnectDelayMs?: number;
  /** Nombre maximal de fenêtres consécutives sans final — défaut 150 (~75 min). */
  maxReconnects?: number;
}

export class Gen3iaClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly projectId?: string;
  private readonly firebaseToken?: string | (() => string | Promise<string>);
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  readonly agents: {
    run(agentId: string, input: { objective: string; signal?: AbortSignal }): Promise<AgentRunResult>;
  };

  readonly missions: {
    run(input: RunMissionInput, options?: { signal?: AbortSignal }): Promise<MissionRunResult>;
    get(runId: string, options?: { signal?: AbortSignal }): Promise<MissionRunStatus>;
    waitFor(
      runId: string,
      options?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal },
    ): Promise<MissionRunStatus>;
    stream(
      runId: string,
      handlers: MissionStreamHandlers,
      options?: { signal?: AbortSignal },
    ): Promise<MissionStreamHandle>;
    follow(
      runId: string,
      handlers: MissionStreamHandlers,
      options?: MissionFollowOptions,
    ): Promise<{ close(): void }>;
  };

  readonly publicAgents: {
    get(agentId: string, options?: { signal?: AbortSignal }): Promise<PublicAgentInfo>;
    chat(agentId: string, input: { message: string }, options?: { signal?: AbortSignal }): Promise<PublicAgentChatResult>;
  };

  readonly commercial: {
    get(slug: string, options?: { signal?: AbortSignal }): Promise<CommercialSalonInfo>;
    chat(slug: string, input: CommercialChatInput, options?: { signal?: AbortSignal }): Promise<CommercialChatResult>;
  };

  readonly webhooks: {
    /** Déclenche une mission « agent toujours actif » — payload libre (JSON ou texte brut). */
    trigger(token: string, payload?: unknown, options?: { signal?: AbortSignal }): Promise<WebhookTriggerResult>;
  };

  constructor(options: Gen3iaClientOptions = {}) {
    // Normalisation linéaire (trimTrailingSlashes) — jamais une regex sur
    // donnée d'entrée (CodeQL js/polynomial-redos, alerte #53).
    this.baseUrl = trimTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
    this.apiKey = options.apiKey;
    this.projectId = options.projectId;
    this.firebaseToken = options.firebaseToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;

    const client = this;

    this.agents = {
      async run(agentId, input) {
        const { data } = await client.request<AgentRunResult>("POST", `/api/v1/agents/${encodeURIComponent(agentId)}/run`, {
          auth: "developer",
          body: { objective: input.objective },
          signal: input.signal,
          timeoutMs: AGENT_RUN_TIMEOUT_MS,
        });
        return data;
      },
    };

    this.missions = {
      async run(input, options) {
        const { data } = await client.request<MissionRunResult>("POST", "/api/agents/run", {
          auth: "session",
          body: input,
          signal: options?.signal,
        });
        return data;
      },
      async get(runId, options) {
        const { data } = await client.request<MissionRunStatus>("GET", `/api/agents/runs/${encodeURIComponent(runId)}`, {
          auth: "session",
          signal: options?.signal,
        });
        return data;
      },
      async waitFor(runId, options) {
        const timeoutMs = options?.timeoutMs ?? 600_000;
        const pollMs = options?.pollMs ?? 2_000;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const status = await client.missions.get(runId, { signal: options?.signal });
          if (["completed", "failed", "cancelled", "paused"].includes(status.status)) return status;
          if (Date.now() >= deadline) {
            throw new Gen3iaTimeoutError(`La mission ${runId} n'est pas terminée après ${timeoutMs} ms (statut ${status.status}).`);
          }
          await sleep(pollMs);
        }
      },
      async stream(runId, handlers, options) {
        return client.streamOnce(runId, handlers, options);
      },
      async follow(runId, handlers, options) {
        return client.followRun(runId, handlers, options);
      },
    };

    this.publicAgents = {
      async get(agentId, options) {
        const { data } = await client.request<PublicAgentInfo>("GET", `/api/public/agents/${encodeURIComponent(agentId)}`, {
          auth: "none",
          signal: options?.signal,
        });
        return data;
      },
      async chat(agentId, input, options) {
        const { data } = await client.request<PublicAgentChatResult>("POST", `/api/public/agents/${encodeURIComponent(agentId)}`, {
          auth: "none",
          body: { message: input.message },
          signal: options?.signal,
        });
        return data;
      },
    };

    this.commercial = {
      async get(slug, options) {
        const { data } = await client.request<CommercialSalonInfo>("GET", `/api/public/commercial/${encodeURIComponent(slug)}`, {
          auth: "none",
          signal: options?.signal,
        });
        return data;
      },
      async chat(slug, input, options) {
        const { data } = await client.request<CommercialChatResult>("POST", `/api/public/commercial/${encodeURIComponent(slug)}`, {
          auth: "none",
          body: input,
          signal: options?.signal,
        });
        return data;
      },
    };

    this.webhooks = {
      async trigger(token, payload, options) {
        const { data } = await client.request<WebhookTriggerResult>("POST", `/api/webhooks/agent-triggers/${encodeURIComponent(token)}`, {
          auth: "none",
          body: payload,
          signal: options?.signal,
          // Payload non-JSON (texte brut) : le serveur l'accepte tronqué.
          rawBody: payload !== undefined && (typeof payload === "string" || !isJsonifiable(payload)) ? payload : undefined,
        });
        return data;
      },
    };
  }

  /** Sonde de disponibilité — publique, sans authentification. */
  async health(options?: { signal?: AbortSignal }): Promise<HealthInfo> {
    const { data } = await this.request<HealthInfo>("GET", "/api/public/health", { auth: "none", signal: options?.signal });
    return data;
  }

  // ─── Cœur requête ────────────────────────────────────────────────────────

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async authHeaders(mode: AuthMode): Promise<Record<string, string>> {
    if (mode === "none") return {};
    if (mode === "developer") {
      if (!this.apiKey || !this.projectId) {
        throw new Gen3iaConfigurationError(
          "Cette méthode requiert une clé développeur : construisez le client avec { apiKey: 'g3x_…', projectId: '…' }.",
        );
      }
      return { Authorization: `Bearer ${this.apiKey}`, "X-Gen3ia-Project-Id": this.projectId };
    }
    if (!this.firebaseToken) {
      throw new Gen3iaConfigurationError(
        "Cette méthode requiert un token de session : construisez le client avec { firebaseToken: '…' } (ID token Firebase).",
      );
    }
    const token = typeof this.firebaseToken === "string" ? this.firebaseToken : await this.firebaseToken();
    return { Authorization: `Bearer ${token}` };
  }

  private async request<T>(method: string, path: string, options: RequestOptions & { rawBody?: unknown }): Promise<RequestResult<T>> {
    const authHeaders = await this.authHeaders(options.auth);
    const retryable = options.retryable ?? method === "GET";
    const maxAttempts = retryable ? this.maxRetries + 1 : 1;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await sleep(backoffDelay(this.retryBaseDelayMs, attempt - 1));
      try {
        return await this.requestOnce<T>(method, path, options, authHeaders);
      } catch (error) {
        lastError = error;
        const isTransientNetwork = error instanceof Gen3iaNetworkError;
        const isTransientStatus = error instanceof Gen3iaApiError && [502, 503, 504].includes(error.status);
        if (!retryable || !(isTransientNetwork || isTransientStatus)) throw error;
      }
    }
    throw lastError;
  }

  private async requestOnce<T>(
    method: string,
    path: string,
    options: RequestOptions & { rawBody?: unknown },
    authHeaders: Record<string, string>,
  ): Promise<RequestResult<T>> {
    const headers: Record<string, string> = { ...authHeaders };
    if (options.accept) headers.Accept = options.accept;

    let body: string | undefined;
    if (options.rawBody !== undefined) {
      body = typeof options.rawBody === "string" ? options.rawBody : JSON.stringify(options.rawBody);
      headers["Content-Type"] = "text/plain; charset=utf-8";
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }

    const signal = combinedSignal(options.timeoutMs ?? this.timeoutMs, options.signal);

    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), { method, headers, body, signal });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new Gen3iaNetworkError(`Requête ${method} ${path} injoignable : ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    const requestId = response.headers.get("x-request-id") ?? undefined;
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));

    const rawText = await response.text().catch(() => "");
    let parsedBody: unknown = undefined;
    if (rawText.trim()) {
      try {
        parsedBody = JSON.parse(rawText);
      } catch {
        parsedBody = undefined;
      }
    }

    if (!response.ok) {
      const errorField = (parsedBody as { error?: unknown } | undefined)?.error;
      throw new Gen3iaApiError(messageFromErrorBody(errorField, `Erreur ${response.status} sur ${path}`), {
        status: response.status,
        requestId,
        issues: errorField && typeof errorField === "object" ? errorField : undefined,
        retryAfterMs,
      });
    }

    if (parsedBody === undefined && rawText.trim()) {
      throw new Gen3iaApiError(`Réponse non JSON de ${path}`, { status: response.status, requestId });
    }

    return { data: parsedBody as T, response };
  }

  // ─── SSE ─────────────────────────────────────────────────────────────────

  private async streamOnce(
    runId: string,
    handlers: MissionStreamHandlers,
    options: { signal?: AbortSignal } | undefined,
  ): Promise<MissionStreamHandle> {
    const controller = new AbortController();
    const close = () => controller.abort();
    const onExternalAbort = () => close();
    options?.signal?.addEventListener("abort", onExternalAbort, { once: true });

    const authHeaders = await this.authHeaders("session").catch((error) => {
      options?.signal?.removeEventListener("abort", onExternalAbort);
      throw error;
    });

    const done = (async () => {
      try {
        const response = await this.fetchImpl(this.url(`/api/agents/runs/${encodeURIComponent(runId)}/stream`), {
          method: "GET",
          headers: { ...authHeaders, Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const requestId = response.headers.get("x-request-id") ?? undefined;
          handlers.onError?.(new Gen3iaApiError(`Flux indisponible (HTTP ${response.status})`, { status: response.status, requestId }));
          return;
        }
        const parser = createSseParser((event) => {
          if (event.data === "") return;
          let payload: unknown;
          try {
            payload = JSON.parse(event.data);
          } catch {
            handlers.onError?.(new Gen3iaError(`Événement SSE « ${event.event} » non JSON.`));
            return;
          }
          if (event.event === "progress") handlers.onProgress?.(payload as MissionProgressEvent);
          else if (event.event === "final") {
            handlers.onFinal?.(payload as MissionFinalEvent);
            close();
          }
          // Autres événements : contrat inconnu — ignorés silencieusement.
        });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        parser.end();
      } catch (error) {
        // Abort volontaire (close()) : sortie silencieuse — pas une erreur.
        if (!controller.signal.aborted) handlers.onError?.(error);
      } finally {
        options?.signal?.removeEventListener("abort", onExternalAbort);
      }
    })();

    return { close, done };
  }

  private async followRun(
    runId: string,
    handlers: MissionStreamHandlers,
    options: MissionFollowOptions | undefined,
  ): Promise<{ close(): void }> {
    const reconnectDelayMs = options?.reconnectDelayMs ?? 500;
    const maxReconnects = options?.maxReconnects ?? 150;
    const deadline = options?.maxDurationMs ? Date.now() + options.maxDurationMs : undefined;

    let terminated = false;
    let currentClose: (() => void) | undefined;
    const close = () => {
      terminated = true;
      currentClose?.();
    };

    const run = (async () => {
      for (let window = 0; !terminated && window < maxReconnects; window++) {
        if (options?.signal?.aborted) return;
        if (deadline !== undefined && Date.now() >= deadline) {
          handlers.onError?.(new Gen3iaTimeoutError(`Suivi de la mission ${runId} arrêté : durée maximale dépassée.`));
          return;
        }
        let sawFinal = false;
        const handle = await this.streamOnce(runId, {
          onProgress: handlers.onProgress,
          onFinal: (event) => {
            sawFinal = true;
            handlers.onFinal?.(event);
          },
          onError: handlers.onError,
        }, { signal: options?.signal });
        currentClose = handle.close;
        await handle.done;
        if (sawFinal || terminated || options?.signal?.aborted) return;
        // Fenêtre serveur écoulée (~50 s) : reconnexion — la mission vit dans la file.
        if (deadline !== undefined && Date.now() >= deadline) {
          handlers.onError?.(new Gen3iaTimeoutError(`Suivi de la mission ${runId} arrêté : durée maximale dépassée.`));
          return;
        }
        await sleep(reconnectDelayMs);
      }
    })();

    return { close };
  }
}

function isJsonifiable(payload: unknown): boolean {
  return payload === null || typeof payload === "object" || Array.isArray(payload) ||
    typeof payload === "number" || typeof payload === "boolean";
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1_000);
}
