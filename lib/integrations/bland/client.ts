import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { logger } from "@/lib/observability/logger";

/**
 * CLIENT BLAND AI — plateforme d'appels vocaux IA (remplace Twilio/Plivo).
 *
 * Contrat API vérifié sur la documentation officielle (docs.bland.ai) :
 *  - POST   /v1/calls                : envoi d'appel (tâche ou agent_id) ;
 *  - GET    /v1/calls/{call_id}      : détails d'appel (statut, transcripts…) ;
 *  - POST   /v1/calls/{call_id}/stop : arrêt d'un appel actif ;
 *  - POST   /v2/agents               : création d'agent (dev/staging/production) ;
 *  - GET    /v2/agents               : liste des agents ;
 *  - POST   /v2/agents/{id}/publish  : publication d'un snapshot en staging ;
 *  - POST   /v2/agents/{id}/promote  : promotion du staging en production ;
 *  - DELETE /v2/agents/{agent_id}    : suppression douce.
 *
 * Authentification : `authorization: Bearer <clé org>` (la clé nue est
 * aussi acceptée ; x-api-key n'est PAS lu par Bland).
 *
 * Réponses v1 : { status: "success", call_id, ... }.
 * Réponses v2 : { data: …, errors: null | [{ error, message }] }.
 */

export const BLAND_API_BASE = "https://api.bland.ai";

/** Délai maximal par requête vers l'API Bland (ms). */
const BLAND_TIMEOUT_MS = Number(process.env.BLAND_TIMEOUT_MS ?? 30_000);

/** Erreur normalisée Bland (statut HTTP + code d'erreur éventuel). */
export class BlandError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "BlandError";
    this.status = status;
    this.code = code;
  }
}

/** Clé API Bland (server-only). Lance si absente. */
export function getBlandApiKey(): string {
  const key = process.env.BLAND_API_KEY?.trim();
  if (!key) {
    throw new BlandError(
      "Appels vocaux indisponibles : clé API Bland manquante (BLAND_API_KEY).",
      503,
      "MISSING_API_KEY",
    );
  }
  return key;
}

/** La plateforme Bland est-elle configurée ? */
export function isBlandConfigured(): boolean {
  return Boolean(process.env.BLAND_API_KEY?.trim());
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

async function blandFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BLAND_TIMEOUT_MS);
  try {
    const response = await fetch(`${BLAND_API_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${getBlandApiKey()}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
      cache: "no-store",
    });
    const raw = await response.text();
    let payload: unknown = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      const record = (payload ?? {}) as {
        error?: string;
        message?: string;
        errors?: Array<{ error?: string; message?: string }>;
      };
      const code = record.errors?.[0]?.error ?? record.error;
      const message =
        record.errors?.[0]?.message ??
        record.message ??
        (raw ? raw.slice(0, 300) : `HTTP ${response.status}`);
      throw new BlandError(`Bland AI : ${message}`, response.status, code);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof BlandError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new BlandError("Bland AI : délai d'attente dépassé.", 504, "TIMEOUT");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/* ------------------------------------------------------------------ */
/* Types agents (API v2)                                               */
/* ------------------------------------------------------------------ */

export interface BlandAgent {
  id: string;
  org_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface BlandEnvironment {
  id: string;
  env_type: "dev" | "staging" | "production";
  current_version_id: string | null;
}

/** Nœud du graphe comportemental (shapé { nodes, edges }, validé récursivement). */
export interface BlandBehaviorNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface BlandBehaviorEdge {
  id: string;
  source: string;
  target: string;
}

/**
 * Snapshot v2 : configuration COMPLÈTE d'un agent (immuable une fois
 * enregistrée). Clés requises : behavior, settings, contact.
 */
export interface BlandSnapshot {
  behavior: { nodes: BlandBehaviorNode[]; edges: BlandBehaviorEdge[] };
  settings: {
    displayName: string;
    systemPrompt: string;
    voice?: string;
    languages?: string[];
    enableMemory?: boolean;
    backgroundNoise?: string;
    interruptionSensitivity?: number;
    voiceCall?: boolean;
    webChat?: boolean;
    [key: string]: unknown;
  };
  contact: { inboundNumbers: string[] };
  knowledge?: { kbIds: string[] };
}

interface CreateAgentResponse {
  data: { agent: BlandAgent; environments: BlandEnvironment[] } | null;
  errors: Array<{ error?: string; message?: string }> | null;
}

interface PublishResponse {
  data: { version: { id: string; agent_id: string; created_at: string }; semver: string; environments: BlandEnvironment[] } | null;
  errors: Array<{ error?: string; message?: string }> | null;
}

interface PromoteResponse {
  data: { semver: string; environments: BlandEnvironment[] } | null;
  errors: Array<{ error?: string; message?: string }> | null;
}

/** Crée un agent Bland (3 environnements vides, aucune configuration). */
export async function createBlandAgent(name: string): Promise<{ agent: BlandAgent; environments: BlandEnvironment[] }> {
  const payload = await blandFetch<CreateAgentResponse>("/v2/agents", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  if (!payload?.data?.agent?.id) {
    throw new BlandError("Bland AI : création d'agent impossible.", 502, payload?.errors?.[0]?.error);
  }
  return { agent: payload.data.agent, environments: payload.data.environments ?? [] };
}

/** Liste les agents de l'organisation (plus récemment mis à jour d'abord). */
export async function listBlandAgents(limit = 100): Promise<BlandAgent[]> {
  const payload = await blandFetch<{ data: BlandAgent[] | null }>(`/v2/agents?limit=${encodeURIComponent(String(limit))}`);
  return Array.isArray(payload?.data) ? payload.data : [];
}

/** Lit un agent Bland. */
export async function getBlandAgent(agentId: string): Promise<BlandAgent | null> {
  const payload = await blandFetch<{ data: BlandAgent | null }>(`/v2/agents/${encodeURIComponent(agentId)}`);
  return payload?.data && typeof payload.data === "object" && "id" in payload.data ? payload.data : null;
}

/**
 * Publie un snapshot : enregistre une NOUVELLE version sur la timeline dev
 * ET épingle le staging dessus (une seule requête — cf. doc Publish Agent).
 */
export async function publishBlandAgentSnapshot(
  agentId: string,
  snapshot: BlandSnapshot,
  bump: "patch" | "minor" | "major" = "minor",
): Promise<{ versionId: string; semver: string; environments: BlandEnvironment[] }> {
  const payload = await blandFetch<PublishResponse>(`/v2/agents/${encodeURIComponent(agentId)}/publish`, {
    method: "POST",
    body: JSON.stringify({ snapshot, bump }),
  });
  if (!payload?.data?.version?.id || !payload.data.semver) {
    throw new BlandError("Bland AI : publication de l'agent impossible.", 502, payload?.errors?.[0]?.error);
  }
  return { versionId: payload.data.version.id, semver: payload.data.semver, environments: payload.data.environments ?? [] };
}

/** Épingle la production sur la version actuellement en staging. */
export async function promoteBlandAgent(agentId: string): Promise<{ semver: string; environments: BlandEnvironment[] }> {
  const payload = await blandFetch<PromoteResponse>(`/v2/agents/${encodeURIComponent(agentId)}/promote`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (!payload?.data?.semver) {
    throw new BlandError("Bland AI : promotion de l'agent impossible.", 502, payload?.errors?.[0]?.error);
  }
  return { semver: payload.data.semver, environments: payload.data.environments ?? [] };
}

/** Suppression douce d'un agent Bland. */
export async function deleteBlandAgent(agentId: string): Promise<void> {
  await blandFetch(`/v2/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
}

/* ------------------------------------------------------------------ */
/* Types appels (API v1)                                               */
/* ------------------------------------------------------------------ */

/** Tour de transcript normalisé (roles Gen3ia : assistant | user). */
export interface BlandTranscriptTurn {
  role: "assistant" | "user";
  text: string;
  at: string;
}

/** Détails d'appel Bland NORMALISÉS (champs bruts mappés Gen3ia). */
export interface BlandCallDetails {
  callId: string;
  status: string;
  completed: boolean;
  queueStatus: string | null;
  answeredBy: string | null;
  callEndedBy: string | null;
  errorMessage: string | null;
  to: string | null;
  from: string | null;
  lengthMinutes: number | null;
  priceUsd: number | null;
  summary: string | null;
  concatenatedTranscript: string | null;
  transcripts: BlandTranscriptTurn[];
  recordingUrl: string | null;
  createdAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  metadata: Record<string, unknown> | null;
  variables: Record<string, unknown> | null;
  batchId: string | null;
}

/** Entrée d'appel sortant. Le mode agent (agent_id) est le mode Gen3ia. */
export interface SendBlandCallInput {
  phoneNumber: string;
  agentId?: string;
  task?: string;
  firstSentence?: string;
  voice?: string;
  language?: string;
  maxDurationMinutes?: number;
  record?: boolean;
  webhook?: string;
  webhookEvents?: string[];
  metadata?: Record<string, unknown>;
  requestData?: Record<string, unknown>;
  externalId?: string;
  keywords?: string[];
  timezone?: string;
  transferPhoneNumber?: string;
  variables?: Record<string, string>;
}

/** Mappe un rôle de transcript Bland vers Gen3ia (robot/IVR → user). */
function mapTranscriptRole(user: unknown): "assistant" | "user" | null {
  if (user === "assistant" || user === "user") return user;
  if (user === "robot") return "user";
  return null; // agent-action et autres : tours non parlés, ignorés.
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Normalise le payload d'un appel Bland (réponses GET /v1/calls/{id} et
 * webhooks post-appel partagent ces champs) vers BlandCallDetails.
 */
export function normalizeBlandCallDetails(payload: Record<string, unknown>): BlandCallDetails {
  const transcripts = Array.isArray(payload.transcripts)
    ? (payload.transcripts as Array<Record<string, unknown>>).flatMap((turn) => {
        const role = mapTranscriptRole(turn.user);
        const text = asString(turn.text);
        return role && text ? [{ role, text, at: asString(turn.created_at) ?? "" }] : [];
      })
    : [];
  return {
    callId: asString(payload.call_id) ?? asString(payload.c_id) ?? "",
    status: asString(payload.status) ?? "unknown",
    completed: payload.completed === true || payload.queue_status === "complete",
    queueStatus: asString(payload.queue_status),
    answeredBy: asString(payload.answered_by),
    callEndedBy: asString(payload.call_ended_by),
    errorMessage: asString(payload.error_message),
    to: asString(payload.to),
    from: asString(payload.from),
    lengthMinutes: asNumber(payload.call_length),
    priceUsd: asNumber(payload.price),
    summary: asString(payload.summary),
    concatenatedTranscript: asString(payload.concatenated_transcript),
    transcripts,
    recordingUrl: asString(payload.recording_url),
    createdAt: asString(payload.created_at),
    startedAt: asString(payload.started_at),
    endedAt: asString(payload.ended_at),
    metadata: payload.metadata && typeof payload.metadata === "object" ? (payload.metadata as Record<string, unknown>) : null,
    variables: payload.variables && typeof payload.variables === "object" ? (payload.variables as Record<string, unknown>) : null,
    batchId: asString(payload.batch_id),
  };
}

/** Envoie un appel vocal IA. Retourne l'identifiant d'appel Bland. */
export async function sendBlandCall(input: SendBlandCallInput): Promise<{ callId: string; status: string }> {
  const body: Record<string, unknown> = {
    phone_number: input.phoneNumber,
    record: input.record ?? true,
  };
  if (input.agentId) body.agent_id = input.agentId;
  if (input.task) body.task = input.task;
  if (input.firstSentence) body.first_sentence = input.firstSentence;
  if (input.voice) body.voice = input.voice;
  if (input.language) body.language = input.language;
  if (input.maxDurationMinutes !== undefined) body.max_duration = Math.max(1, Math.min(60, Math.round(input.maxDurationMinutes)));
  if (input.webhook) {
    body.webhook = input.webhook;
    if (input.webhookEvents?.length) body.webhook_events = input.webhookEvents;
  }
  if (input.metadata) body.metadata = input.metadata;
  if (input.requestData) body.request_data = input.requestData;
  if (input.externalId) body.external_id = input.externalId;
  if (input.keywords?.length) body.keywords = input.keywords;
  if (input.timezone) body.timezone = input.timezone;
  if (input.transferPhoneNumber) body.transfer_phone_number = input.transferPhoneNumber;
  if (input.variables) body.variables = input.variables;

  const payload = await blandFetch<{ status?: string; call_id?: string; c_id?: string; message?: string }>("/v1/calls", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const callId = asString(payload?.call_id) ?? asString(payload?.c_id);
  if (!callId) {
    throw new BlandError(
      `Bland AI : appel refusé${asString(payload?.message) ? ` (${payload.message})` : ""}.`,
      502,
      "NO_CALL_ID",
    );
  }
  return { callId, status: asString(payload?.status) ?? "queued" };
}

/** Lit l'état courant d'un appel (polling de suivi). */
export async function getBlandCall(callId: string): Promise<BlandCallDetails> {
  const payload = await blandFetch<Record<string, unknown>>(`/v1/calls/${encodeURIComponent(callId)}`);
  return normalizeBlandCallDetails(payload ?? {});
}

/** Arrête un appel actif. */
export async function stopBlandCall(callId: string): Promise<void> {
  await blandFetch(`/v1/calls/${encodeURIComponent(callId)}/stop`, { method: "POST", body: JSON.stringify({}) });
}

/* ------------------------------------------------------------------ */
/* Webhooks — signature HMAC                                          */
/* ------------------------------------------------------------------ */

/** Le secret de signature des webhooks Bland est-il configuré ? */
export function isBlandWebhookSecretConfigured(): boolean {
  return Boolean(process.env.BLAND_WEBHOOK_SECRET?.trim());
}

/**
 * Vérifie X-Webhook-Signature : HMAC-SHA256 hex du corps BRUT exact reçu.
 * Comparaison à temps constant. Retourne false si secret absent ou invalide.
 */
export function verifyBlandWebhookSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.BLAND_WEBHOOK_SECRET?.trim();
  if (!secret || !signature) {
    logger.warn({ reason: secret ? "missing_header" : "missing_secret" }, "bland_webhook_signature_skipped");
    return false;
  }
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
