/**
 * Contrats de données de l'API Gen3ia exposés par le SDK.
 *
 * Chaque type reflète STRICTEMENT la réponse du serveur (routes Next) :
 * les champs optionnels correspondent à des réponses conditionnelles du
 * backend, jamais à des inventions. Toute évolution du serveur doit passer
 * par ici (le SDK est versionné avec le dépôt — une même PR peut mettre à
 * jour les deux côtés du contrat).
 */

// ─── Santé ───────────────────────────────────────────────────────────────────

export interface HealthInfo {
  ok: boolean;
  service: string;
  /** Horodatage ISO 8601 du serveur (fraîcheur garantie — no-store). */
  time: string;
}

// ─── Agents personnalisés (clé développeur g3x_) ─────────────────────────────

export interface AgentIdentity {
  id: string;
  name: string;
  type: string;
}

export interface BillingSummary {
  totalChargeMinor?: number;
  totalProviderCostEur?: number;
  llmInputTokens?: number;
  llmOutputTokens?: number;
}

export interface AgentRunResult {
  executionId: string;
  requestId?: string;
  agent: AgentIdentity;
  /** Statut runtime terminal de l'exécution synchrone (ex. « completed »). */
  status: string;
  /** Sorties nommées de l'exécution — la dernière chaîne non vide est la réponse. */
  outputs: Record<string, unknown>;
  observations: unknown[];
  billing?: BillingSummary;
  durationMs?: number;
}

// ─── Missions (API de session, file de ticks R2) ─────────────────────────────

/** Plan optionnel d'exécution — par défaut, un pas LLM unique est créé côté serveur. */
export interface RuntimeStepInput {
  id: string;
  type: string;
  name?: string;
  description?: string;
  dependencies?: string[];
  status?: string;
  input?: Record<string, unknown>;
  skillIds?: string[];
  maxRetries?: number;
  timeoutMs?: number;
  sideEffect?: boolean;
  requiresApproval?: boolean;
}

export interface RuntimePlanInput {
  steps: RuntimeStepInput[];
  maxConcurrency?: number;
  maxIterations?: number;
}

export interface RunMissionInput {
  /** Objectif de la mission (3 à 50 000 caractères côté serveur). */
  objective: string;
  /** Projet développeur rattaché — doit appartenir au compte appelant. */
  projectId?: string;
  /** Organisation propriétaire (Task 58) — l'appelant doit en être membre. */
  orgId?: string;
  /** « auto » (défaut) : async si la file est configurée, sinon sync. */
  mode?: "auto" | "async" | "sync";
  /** Plan explicite — sinon un pas LLM unique exécute l'objectif. */
  plan?: RuntimePlanInput;
}

/** Réponse 202 — mission enfilée, suivre via statusUrl / streamUrl. */
export interface MissionQueued {
  runId: string;
  executionId: string;
  requestId?: string;
  status: "queued";
  async: true;
  statusUrl: string;
  streamUrl: string;
  pollSeconds: number;
}

/** Réponse 200 — exécution synchrone terminée dans la requête. */
export interface MissionSyncResult {
  executionId: string;
  requestId?: string;
  status: string;
  outputs: Record<string, unknown>;
  observations: unknown[];
  async: false;
}

export type MissionRunResult = MissionQueued | MissionSyncResult;

export type MissionStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused";

/** Étape de timeline compacte (aperçu borné — jamais de binaire). */
export interface MissionTimelineStep {
  id: string;
  name: string;
  type: string;
  status: string;
  outputPreview?: string;
}

export interface MissionRunStatus {
  runId: string;
  status: MissionStatus;
  objective: string;
  projectId?: string;
  attempts: number;
  pendingCount: number;
  timeline: MissionTimelineStep[];
  lastError?: string;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
}

/** Événement `progress` du flux SSE — miroir du document de file. */
export interface MissionProgressEvent {
  runId: string;
  status: MissionStatus;
  pendingCount: number;
  attempts: number;
  timeline: MissionTimelineStep[];
  updatedAtMs: number;
  lastError?: string;
}

/** Événement `final` du flux SSE — termine le suivi. */
export interface MissionFinalEvent {
  runId: string;
  status: MissionStatus | "not_found";
  lastError?: string;
}

// ─── Surface publique (sans authentification) ────────────────────────────────

export interface PublicAgentInfo {
  name: string;
  description: string;
}

export interface PublicAgentChatResult {
  text: string;
}

export interface CommercialSalonInfo {
  companyName: string;
  agentName: string;
  welcomeMessage: string;
  language: string;
}

export interface CommercialChatInput {
  message: string;
  /** Identifiant de conversation client — généré côté serveur si absent. */
  conversationId?: string;
  clientName?: string;
  clientContact?: string;
}

export interface CommercialChatResult {
  text: string;
  conversationId: string;
}

// ─── Webhooks entrants « agent toujours actif » ──────────────────────────────

export interface WebhookTriggerResult {
  ok: true;
  executionId: string;
  status: "accepted";
}
