import "server-only";

import { randomUUID } from "node:crypto";
import {
  listJson,
  newUlid,
  patchJson,
  readJsonIfExists,
  UserDataError,
  userDir,
  userKey,
  writeJson,
} from "@/lib/storage/user-data-store";
import type { ConversationRun, RunPhase, RunStatus, RunStep, RunStepStatus } from "@/lib/domain/conversations/types";

/**
 * Run — exécution d'un plan ou d'un outil dans une conversation.
 * La timeline (steps ordonnés par phase) est stockée dans le document :
 * lecture en une requête pour l'affichage inline repliable.
 *
 * Backend Cloudflare R2 (Task 109) : clé canonique
 * `users/{uid}/runs/{runId}.json` — doc { v:1, id, userId, conversationId,
 * …champs actuels }, runId = newUlid() (tri lexicographique des clés =
 * ordre chronologique). Les runs sont des DONNÉES UTILISATEUR par
 * utilisateur : aucune clé globale, aucun scan cross-tenant possible.
 *
 * Surface d'API STRICTEMENT identique au backend Firestore — zéro
 * modification de route nécessaire.
 */

/** Segment préfixe des runs sous l'espace utilisateur. */
const RUNS_SEGMENT = "runs";

/**
 * Les payloads runtime compactés (lib/agents/conversation-run) montent à
 * ~400 Ko ; le plafond d'écriture par défaut de la fondation (256 Ko) serait
 * dépassé — les écritures de runs portent explicitement 512 Ko. Les lectures
 * portent 1 Mo (mémoire du plafond Firestore) : un run écrit à 512 Ko se
 * relit toujours, et aucun document lisible n'est silencieusement écarté
 * des scans (listJson ignore les too_large).
 */
const RUN_WRITE_MAX_BYTES = 512 * 1024;
const RUN_READ_MAX_BYTES = 1024 * 1024;

/** Préfixe des runs d'un utilisateur : users/{uid}/runs */
function runsPrefix(userId: string): string {
  return userDir(userId, RUNS_SEGMENT);
}

/** Clé d'un run : users/{uid}/runs/{runId}.json */
function runKey(userId: string, runId: string): string {
  return userKey(userId, RUNS_SEGMENT, runId);
}

/** Horodatage lisible (ISO) d'une valeur stockée string | Date. */
function isoTime(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  return new Date().toISOString();
}

interface RunDoc { [key: string]: unknown; id?: string; userId?: unknown; conversationId?: unknown; }

function docFrom(id: string, data: RunDoc): ConversationRun {
  const steps = Array.isArray(data.steps) ? (data.steps as RunStep[]) : [];
  return {
    id,
    userId: String(data.userId ?? ""),
    conversationId: String(data.conversationId ?? ""),
    projectId: typeof data.projectId === "string" ? data.projectId : undefined,
    executionId: typeof data.executionId === "string" ? data.executionId : undefined,
    objective: String(data.objective ?? ""),
    status: (data.status ?? "planning") as RunStatus,
    steps: steps.map((s) => ({ ...s, id: String(s.id), phase: s.phase, title: String(s.title), status: s.status })),
    runtime: data.runtime && typeof data.runtime === "object" ? (data.runtime as Record<string, unknown>) : undefined,
    createdAt: isoTime(data.createdAt),
    updatedAt: isoTime(data.updatedAt),
    finishedAt: data.finishedAt instanceof Date || typeof data.finishedAt === "string" ? isoTime(data.finishedAt) : undefined,
  };
}

/** Dédaine la lecture d'un lot de documents runs en ConversationRun triés createdAt desc. */
function sortedRunsDesc(docs: RunDoc[]): ConversationRun[] {
  return docs
    .map((d) => docFrom(typeof d.id === "string" && d.id ? d.id : "", d))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function makeStep(input: {
  phase: RunPhase;
  title: string;
  detail?: string;
  toolName?: string;
  toolInput?: unknown;
  status?: RunStepStatus;
}): RunStep {
  return {
    id: randomUUID(),
    phase: input.phase,
    title: input.title.slice(0, 200),
    detail: input.detail?.slice(0, 4000),
    toolName: input.toolName,
    toolInput: input.toolInput,
    status: input.status ?? "pending",
  };
}

export async function createRun(input: {
  userId: string;
  conversationId: string;
  projectId?: string;
  /** Identifiant d'exécution runtime (mode agent : réconciliation après approbation). */
  executionId?: string;
  objective: string;
  steps: RunStep[];
  /** Payload runtime compact (plan, sorties, observations) pour ré-affichage fidèle. */
  runtime?: Record<string, unknown>;
}): Promise<ConversationRun> {
  const now = new Date();
  // runId ULID : les clés du préfixe se lisent dans l'ordre chronologique.
  const runId = newUlid();
  await writeJson(runKey(input.userId, runId), {
    v: 1,
    id: runId,
    userId: input.userId,
    conversationId: input.conversationId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.executionId ? { executionId: input.executionId } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
    objective: input.objective.slice(0, 2000),
    status: "planning" as const,
    steps: input.steps,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }, { maxBytes: RUN_WRITE_MAX_BYTES });
  return {
    id: runId,
    userId: input.userId,
    conversationId: input.conversationId,
    projectId: input.projectId,
    executionId: input.executionId,
    objective: input.objective,
    status: "planning",
    steps: input.steps,
    runtime: input.runtime,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/**
 * Retrouve le run d'une conversation lié à une exécution runtime (mode
 * agent). Scan préfixe borné (cap 500 clés — périmètre utilisateur) + filtre
 * executionId + tri createdAt desc : le run LE PLUS RÉCENT gagne (les
 * réconciliations successives d'une même exécution réécrivent le dernier).
 */
export async function findRunByExecution(userId: string, executionId: string): Promise<ConversationRun | null> {
  const docs = await listJson<RunDoc>(runsPrefix(userId), { maxBytesPerDoc: RUN_READ_MAX_BYTES });
  const matches = sortedRunsDesc(docs).filter((run) => run.executionId === executionId);
  return matches[0] ?? null;
}

/**
 * Met à jour (upsert limité) le run lié à une exécution : statut final,
 * timeline et payload runtime. Fail-soft : l'absence de run (fils créés
 * avant la fonctionnalité) n'est pas une erreur.
 */
export async function updateRunByExecution(
  userId: string,
  executionId: string,
  patch: { status?: RunStatus; steps?: RunStep[]; runtime?: Record<string, unknown> },
): Promise<ConversationRun | null> {
  const existing = await findRunByExecution(userId, executionId);
  if (!existing) return null;
  const now = new Date().toISOString();
  const update: Partial<RunDoc> = { updatedAt: now };
  if (patch.status) { update.status = patch.status; update.finishedAt = now; }
  if (patch.steps) update.steps = patch.steps;
  if (patch.runtime) update.runtime = patch.runtime;
  await patchJson<RunDoc>(runKey(userId, existing.id), update, { maxBytes: RUN_WRITE_MAX_BYTES });
  // Forme de retour historique conservée : existant + champs fournis.
  return { ...existing, ...patch };
}

export async function getRun(userId: string, runId: string): Promise<ConversationRun | null> {
  // Clé directe chez l'utilisateur : un autre uid ne peut pas lire ce run
  // (cloisonnement par préfixe + garde userId fail-closed conservée).
  const data = await readJsonIfExists<RunDoc>(runKey(userId, runId), { maxBytes: RUN_READ_MAX_BYTES });
  if (!data || String(data.userId ?? "") !== userId) return null;
  return docFrom(runId, data);
}

export async function getRunForConversation(userId: string, runId: string, conversationId: string): Promise<ConversationRun | null> {
  const run = await getRun(userId, runId);
  if (!run || run.conversationId !== conversationId) return null;
  return run;
}

export async function listRunsForConversation(userId: string, conversationId: string, limit = 20): Promise<ConversationRun[]> {
  // Scan préfixe + filtre conversationId + tri createdAt desc (plafond 50) :
  // même sémantique de fenêtre que la requête Firestore historique.
  const docs = await listJson<RunDoc>(runsPrefix(userId), { maxBytesPerDoc: RUN_READ_MAX_BYTES });
  return sortedRunsDesc(docs)
    .filter((run) => run.conversationId === conversationId)
    .slice(0, Math.min(limit, 50));
}

/**
 * Missions récentes TOUTES conversations confondues (étape 16) : la vue
 * globale de l'activité d'exécution de l'utilisateur. Sur R2, le préfixe
 * `users/{uid}/runs/` EST l'index utilisateur — un seul listage (cap 500)
 * puis tri createdAt desc et fenêtre exacte, sans dépendre d'aucun index
 * composite déployé.
 */
export async function listRecentRuns(userId: string, limit = 8): Promise<ConversationRun[]> {
  const capped = Math.min(limit, 20);
  const docs = await listJson<RunDoc>(runsPrefix(userId), { maxBytesPerDoc: RUN_READ_MAX_BYTES });
  return sortedRunsDesc(docs).slice(0, capped);
}

/**
 * Vérifie l'existence du run avant patch : le .update() Firestore historique
 * levait sur un document manquant, et patchJson (fondation 109-a) CRÉE en
 * cas d'absence — un run fantôme sans userId ne doit jamais être créé.
 */
async function assertRunExists(userId: string, runId: string): Promise<void> {
  const key = runKey(userId, runId);
  const existing = await readJsonIfExists<RunDoc>(key, { maxBytes: RUN_READ_MAX_BYTES });
  if (!existing) {
    throw new UserDataError("not_found", `Run absent : ${key}`);
  }
}

export async function updateRunSteps(userId: string, runId: string, steps: RunStep[]): Promise<void> {
  await assertRunExists(userId, runId);
  await patchJson<RunDoc>(runKey(userId, runId), { steps, updatedAt: new Date().toISOString() }, { maxBytes: RUN_WRITE_MAX_BYTES });
}

/** Statut dérivé de la timeline : la source de vérité reste les étapes. */
export function deriveRunStatus(steps: RunStep[]): RunStatus {
  const pendingApprovals = steps.filter((s) => s.status === "awaiting");
  if (pendingApprovals.length > 0) return "awaiting_approval";
  const running = steps.some((s) => s.status === "in_progress" || s.status === "pending");
  if (running) return "running";
  const failed = steps.some((s) => s.status === "failed");
  if (failed) return "failed";
  return "completed";
}

export async function finalizeRun(userId: string, runId: string, status: RunStatus, steps: RunStep[]): Promise<void> {
  await assertRunExists(userId, runId);
  const now = new Date().toISOString();
  await patchJson<RunDoc>(runKey(userId, runId), { status, steps, finishedAt: now, updatedAt: now }, { maxBytes: RUN_WRITE_MAX_BYTES });
}
