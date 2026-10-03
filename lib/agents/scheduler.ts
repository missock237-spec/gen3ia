import { randomUUID, randomBytes } from "crypto";
import { FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore";
import { z } from "zod";

import { adminDb } from "@/lib/firebase/admin";
import { AgentRuntime, RuntimePlanSchema } from "@/lib/agents/runtime";
import { getAgentForUser } from "@/lib/agents/repository";
import { checkWatchSource, type WatchSource } from "@/lib/agents/watch-sources";
import { notifyScheduleRunCompleted } from "@/lib/integrations/messaging/notify";

export const ScheduleSchema = z.object({
  agentId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(3).max(50_000),
  plan: RuntimePlanSchema.omit({ executionId: true, objective: true }).optional(),
  timezone: z.string().trim().min(1).max(100),
  // Fenêtre cron : optionnelle — une planification « toujours active »
  // (webhook ou veille) peut n'avoir aucune fenêtre planifiée.
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  intervalMinutes: z.number().int().min(0).max(1440).default(0),
  // ONE-SHOT (tâche planifiée avancée) : exécution PONCTUELLE à une date
  // précise (epoch ms). Compatible avec une fenêtre cron (les deux
  // déclencheurs coexistent) ; la planification se désarme seule après.
  runAtMs: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
  maxRetries: z.number().int().min(0).max(5).default(2),
  retryDelayMinutes: z.number().int().min(1).max(1440).default(5),
  catchUp: z.boolean().default(false),
  maxCatchUpRuns: z.number().int().min(0).max(10).default(1),
  // ─── Agents toujours actifs ───
  // Demande d'un déclencheur webhook : le token est GÉNÉRÉ SERVEUR (jamais
  // soumis par le client) puis le champ est retiré du document.
  enableWebhook: z.boolean().optional(),
  // Token du webhook entrant (écrit uniquement par le serveur).
  alwaysOnWebhookToken: z.string().trim().max(120).optional(),
  // Sources de veille (RSS / web) : un contenu modifié déclenche l'agent.
  watchSourceInputs: z.array(z.object({
    type: z.enum(["rss", "web"]),
    url: z.string().trim().url().max(2_000),
    label: z.string().trim().max(120).optional(),
  })).max(5).optional(),
  watchSources: z.array(z.object({
    id: z.string().trim().min(1).max(64),
    type: z.enum(["rss", "web"]),
    url: z.string().trim().url().max(2_000),
    label: z.string().trim().max(120).optional(),
    lastHash: z.string().trim().max(64).optional(),
    lastCheckedAt: z.string().optional(),
  })).max(5).optional(),
});

export type AgentSchedule = z.infer<typeof ScheduleSchema> & {
  id: string;
  userId: string;
  lastTriggeredSlot?: string;
  lastExecutionId?: string;
  lastExecutionStatus?: string;
  lastExecutionAt?: string;
  lastError?: string;
  runningExecutionId?: string;
  runningExecutionStartedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  nextRunAt?: string;
  /** État de relance après échec (retry automatique borné). */
  retryState?: { attempt: number; notBeforeMs: number };
};

export type ScheduleRun = {
  id: string;
  scheduleId: string;
  userId: string;
  agentId: string;
  slot: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  attempt?: number;
  trigger?: "scheduled" | "manual" | "retry" | "catch_up" | "webhook" | "watch";
};

const COLLECTION = "agentSchedules";
const RUNS_COLLECTION = "agentScheduleRuns";
const EXECUTION_LEASE_MS = 2 * 60 * 60 * 1000;
// Anti-rafale : une même source de veille n'est pas sondée plus d'une fois
// toutes les 10 minutes (utile quand le cron passe plus souvent que nécessaire).
const WATCH_CHECK_THROTTLE_MS = 10 * 60 * 1000;

function assertTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error("Invalid IANA timezone");
  }
}

function minutes(value: string) {
  const [hours, mins] = value.split(":").map(Number);
  return hours * 60 + mins;
}

function localParts(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: weekdayMap[get("weekday")] ?? -1,
  };
}

function previousCalendarDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day) - 86_400_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function toDateKey(year: number, month: number, day: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function nextOccurrence(schedule: AgentSchedule, now = new Date()) {
  // Partie cron inactive pour une planification sans fenêtre planifiée.
  if (!schedule.daysOfWeek?.length || !schedule.startTime || !schedule.endTime) return undefined;
  const base = new Date(now);
  for (let offset = 0; offset <= 8; offset++) {
    const probe = new Date(base.getTime() + offset * 86_400_000);
    const local = localParts(probe, schedule.timezone);
    if (!schedule.daysOfWeek.includes(local.weekday)) continue;
    const start = minutes(schedule.startTime);
    const end = minutes(schedule.endTime);
    const localDate = toDateKey(local.year, local.month, local.day);
    if (schedule.intervalMinutes <= 0) {
      const candidate = new Date(`${localDate}T${schedule.startTime}:00`);
      if (candidate.getTime() > now.getTime()) return candidate.toISOString();
      continue;
    }
    const elapsedStart = new Date(`${localDate}T${schedule.startTime}:00`);
    const windowMinutes = start <= end ? Math.max(0, end - start) : Math.max(0, 1440 - start + end);
    const maxSlots = Math.floor(windowMinutes / schedule.intervalMinutes);
    for (let slot = 0; slot <= maxSlots; slot++) {
      const candidate = new Date(elapsedStart.getTime() + slot * schedule.intervalMinutes * 60_000);
      if (candidate.getTime() > now.getTime()) return candidate.toISOString();
    }
  }
  return undefined;
}

function calendarDate(local: ReturnType<typeof localParts>) {
  return toDateKey(local.year, local.month, local.day);
}

export function isScheduleActive(schedule: AgentSchedule, now = new Date()) {
  if (!schedule.enabled) return false;
  // ONE-SHOT : actif dès que la date d'exécution est atteinte (le claim
  // transactionnel garantit exactement-une fois, puis auto-désarmement).
  if (typeof schedule.runAtMs === "number" && now.getTime() >= schedule.runAtMs) return true;
  if (!schedule.daysOfWeek?.length || !schedule.startTime || !schedule.endTime) return false;
  const local = localParts(now, schedule.timezone);
  const current = local.hour * 60 + local.minute;
  const start = minutes(schedule.startTime);
  const end = minutes(schedule.endTime);

  if (start === end) return schedule.daysOfWeek.includes(local.weekday);

  if (start > end) {
    if (current < end) {
      const previousWeekday = (local.weekday + 6) % 7;
      return schedule.daysOfWeek.includes(previousWeekday);
    }
    return schedule.daysOfWeek.includes(local.weekday) && current >= start;
  }

  return schedule.daysOfWeek.includes(local.weekday) && current >= start && current < end;
}

function slotFor(schedule: AgentSchedule, now = new Date()) {
  // Garde d'abord : startTime/endTime sont optionnels (plans toujours actifs).
  if (!isScheduleActive(schedule, now)) return null;
  // ONE-SHOT : un slot unique et immuable = exactement-une exécution.
  if (typeof schedule.runAtMs === "number" && now.getTime() >= schedule.runAtMs) {
    return `oneshot:${schedule.runAtMs}`;
  }
  const local = localParts(now, schedule.timezone);
  const current = local.hour * 60 + local.minute;
  const start = minutes(schedule.startTime!);
  const end = minutes(schedule.endTime!);

  let date = calendarDate(local);
  let elapsed: number;
  if (start > end && current < end) {
    const previous = previousCalendarDate(local.year, local.month, local.day);
    date = `${String(previous.year).padStart(4, "0")}-${String(previous.month).padStart(2, "0")}-${String(previous.day).padStart(2, "0")}`;
    elapsed = current + 1440 - start;
  } else {
    elapsed = Math.max(0, current - start);
  }

  if (schedule.intervalMinutes <= 0) return `${date}:start`;
  return `${date}:${Math.floor(elapsed / schedule.intervalMinutes)}`;
}

export async function createSchedule(userId: string, input: unknown) {
  const parsed = ScheduleSchema.parse(input);
  assertTimezone(parsed.timezone);

  // Cohérence des déclencheurs : sans webhook ni veille ni one-shot, la
  // fenêtre cron est obligatoire ; avec un déclencheur événementiel, elle
  // devient optionnelle (l'agent s'exécute à l'événement, pas à l'horloge).
  const wantsWebhook = parsed.enableWebhook === true;
  const wantsWatch = (parsed.watchSourceInputs?.length ?? 0) > 0;
  const wantsOneShot = typeof parsed.runAtMs === "number" && parsed.runAtMs > 0;
  if (!wantsWebhook && !wantsWatch && !wantsOneShot && (!parsed.daysOfWeek?.length || !parsed.startTime || !parsed.endTime)) {
    throw new Error("A schedule requires daysOfWeek/startTime/endTime, a webhook trigger, watch sources, or runAtMs");
  }

  const agent = await getAgentForUser(userId, parsed.agentId);
  if (!agent) throw new Error("Agent not found or not owned by this account");
  if (agent.status !== "active") throw new Error("Only active agents can be scheduled");

  // Always-on : token webhook généré serveur + sources de veille normalisées.
  const alwaysOnWebhookToken = wantsWebhook ? randomBytes(16).toString("hex") : undefined;
  const watchSources = wantsWatch
    ? parsed.watchSourceInputs!.map((source, index) => ({
        id: `src_${index + 1}_${randomBytes(4).toString("hex")}`,
        type: source.type,
        url: source.url,
        ...(source.label?.trim() ? { label: source.label.trim() } : {}),
      }))
    : undefined;

  const id = randomUUID();
  const now = FieldValue.serverTimestamp();

  await adminDb.collection(COLLECTION).doc(id).set({
    agentId: parsed.agentId,
    name: parsed.name,
    objective: parsed.objective,
    ...(parsed.plan ? { plan: parsed.plan } : {}),
    timezone: parsed.timezone,
    ...(parsed.daysOfWeek ? { daysOfWeek: [...new Set(parsed.daysOfWeek)].sort((a, b) => a - b) } : {}),
    ...(parsed.startTime ? { startTime: parsed.startTime } : {}),
    ...(parsed.endTime ? { endTime: parsed.endTime } : {}),
    intervalMinutes: parsed.intervalMinutes,
    ...(wantsOneShot ? { runAtMs: parsed.runAtMs } : {}),
    enabled: parsed.enabled,
    maxRetries: parsed.maxRetries,
    retryDelayMinutes: parsed.retryDelayMinutes,
    catchUp: parsed.catchUp,
    maxCatchUpRuns: parsed.maxCatchUpRuns,
    ...(alwaysOnWebhookToken ? { alwaysOnWebhookToken } : {}),
    ...(watchSources ? { watchSources } : {}),
    userId,
    createdAt: now,
    updatedAt: now,
  });

  return getSchedule(userId, id);
}

export async function getSchedule(userId: string, id: string) {
  const snap = await adminDb.collection(COLLECTION).doc(id).get();
  if (!snap.exists || snap.data()?.userId !== userId) return null;
  return serializeSchedule(snap.id, snap.data()!);
}

export async function listSchedules(userId: string) {
  const snap = await adminDb.collection(COLLECTION).where("userId", "==", userId).limit(100).get();
  return snap.docs
    .map((doc) => serializeSchedule(doc.id, doc.data()))
    .sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));
}

export async function updateSchedule(userId: string, id: string, input: unknown) {
  const parsed = ScheduleSchema.partial().parse(input);
  if (parsed.timezone) assertTimezone(parsed.timezone);

  const ref = adminDb.collection(COLLECTION).doc(id);
  const current = await ref.get();
  if (!current.exists || current.data()?.userId !== userId) return null;

  if (parsed.agentId) {
    const agent = await getAgentForUser(userId, parsed.agentId);
    if (!agent || agent.status !== "active") throw new Error("Agent not found, not owned, or inactive");
  }

  const { enableWebhook: _enableWebhook, watchSourceInputs: _watchSourceInputs, ...rest } = parsed;
  void _enableWebhook;
  void _watchSourceInputs;

  await ref.update({
    ...rest,
    ...(parsed.daysOfWeek ? { daysOfWeek: [...new Set(parsed.daysOfWeek)].sort((a, b) => a - b) } : {}),
    ...(parsed.enabled
      ? { nextRunAt: nextOccurrence({ ...(current.data() as AgentSchedule), ...parsed, id, userId } as AgentSchedule) }
      : { nextRunAt: FieldValue.delete() }),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return getSchedule(userId, id);
}

export async function deleteSchedule(userId: string, id: string) {
  const ref = adminDb.collection(COLLECTION).doc(id);
  const current = await ref.get();
  if (!current.exists || current.data()?.userId !== userId) return false;
  await ref.delete();
  return true;
}

type ClaimedRun = { executionId: string; slot: string };

export async function claimDueSchedule(schedule: AgentSchedule, now = new Date()): Promise<ClaimedRun | null> {
  const slot = slotFor(schedule, now);
  if (!slot) return null;

  const executionId = randomUUID();
  const ref = adminDb.collection(COLLECTION).doc(schedule.id);
  const runRef = adminDb.collection(RUNS_COLLECTION).doc(executionId);

  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;

    const data = snap.data()!;
    if (data.userId !== schedule.userId || data.enabled !== true) return null;
    if (data.lastTriggeredSlot === slot) return null;

    const runningStarted = data.runningExecutionStartedAt instanceof Timestamp
      ? data.runningExecutionStartedAt.toDate().getTime()
      : 0;
    const runningActive = Boolean(data.runningExecutionId) && runningStarted > 0 && now.getTime() - runningStarted < EXECUTION_LEASE_MS;
    if (runningActive) return null;

    const startedAt = Timestamp.fromDate(now);
    tx.update(ref, {
      lastTriggeredSlot: slot,
      runningExecutionId: executionId,
      runningExecutionStartedAt: startedAt,
      lastExecutionId: executionId,
      lastExecutionStatus: "running",
      lastError: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
      nextRunAt: schedule.enabled ? nextOccurrence(schedule, now) : FieldValue.delete(),
    });
    tx.set(runRef, {
      scheduleId: schedule.id,
      userId: schedule.userId,
      agentId: schedule.agentId,
      slot,
      status: "running",
      startedAt,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { executionId, slot };
  });
}

/**
 * Résolution paresseuse de l'organisation propriétaire de l'agent planifié
 * (Task 58) : une lecture Firestore par exécution déclenchée, tolérante aux
 * pannes (agent supprimé / Firestore indisponible → undefined, l'exécution
 * reste personnelle — comportement historique). Les exécutions issues d'un
 * agent rattaché à une organisation portent ainsi orgId dans la collection
 * `executions` (facturation et vues par organisation).
 */
async function resolveAgentOrgId(agentId: string): Promise<string | undefined> {
  try {
    const snap = await adminDb.collection("agents").doc(agentId).get();
    const orgId = snap.exists ? (snap.data() as { orgId?: unknown } | undefined)?.orgId : undefined;
    return typeof orgId === "string" && orgId.trim() ? orgId.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function runSchedule(schedule: AgentSchedule, executionId: string, slot: string, contextNote?: string) {
  const plan = schedule.plan ?? {
    steps: [{
      id: "scheduled_step",
      type: "llm" as const,
      name: "Scheduled agent execution",
      description: schedule.objective,
      dependencies: [],
      status: "pending" as const,
      input: {},
      skillIds: [],
      maxRetries: 2,
      timeoutMs: 120_000,
      sideEffect: false,
      requiresApproval: false,
    }],
    maxConcurrency: 4,
    maxIterations: 10,
  };

  const objective = contextNote ? `${schedule.objective}\n\n${contextNote}` : schedule.objective;

  try {
    const runtime = new AgentRuntime({
      userId: schedule.userId,
      objective,
      plan: { ...plan, executionId, objective },
      // Cloisonnement multi-tenant (Task 58) : organisation de l'agent
      // planifié, résolue paresseusement (échec → exécution personnelle).
      orgId: await resolveAgentOrgId(schedule.agentId),
    });
    const state = await runtime.run();

    await finishScheduleRun(schedule.id, schedule.userId, executionId, state.status, undefined, slot);
    return { executionId, status: state.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scheduled execution failed";
    await finishScheduleRun(schedule.id, schedule.userId, executionId, "failed", message, slot);
    throw error;
  }
}

async function finishScheduleRun(
  scheduleId: string,
  userId: string,
  executionId: string,
  status: string,
  error: string | undefined,
  slot: string,
) {
  const now = Timestamp.now();
  const scheduleRef = adminDb.collection(COLLECTION).doc(scheduleId);
  const runRef = adminDb.collection(RUNS_COLLECTION).doc(executionId);

  await adminDb.runTransaction(async (tx) => {
    const scheduleSnap = await tx.get(scheduleRef);
    if (!scheduleSnap.exists) return;

    const scheduleData = scheduleSnap.data()!;
    if (scheduleData.userId !== userId || scheduleData.runningExecutionId !== executionId) return;

    // RETRY AUTOMATIQUE (tâche planifiée avancée) : un échec borneé plante
    // une relance différée (retryState) tant que maxRetries n'est pas
    // épuisé ; un succès ou l'épuisement des tentatives nettoie l'état.
    const maxRetries = Number(scheduleData.maxRetries ?? 0);
    const retryDelayMs = Number(scheduleData.retryDelayMinutes ?? 5) * 60_000;
    const previousAttempt = Number((scheduleData.retryState as { attempt?: number } | undefined)?.attempt ?? 0);
    let retryState: { attempt: number; notBeforeMs: number } | ReturnType<typeof FieldValue.delete> | undefined;
    if (status === "failed" && maxRetries > 0 && previousAttempt < maxRetries) {
      retryState = { attempt: previousAttempt + 1, notBeforeMs: Date.now() + retryDelayMs };
    } else {
      retryState = FieldValue.delete() as ReturnType<typeof FieldValue.delete>;
    }

    // ONE-SHOT : la planification se DÉSARME après sa première exécution
    // terminée (succès comme échec final) — jamais de re-déclenchement.
    const oneShot = typeof scheduleData.runAtMs === "number";

    tx.update(scheduleRef, {
      runningExecutionId: FieldValue.delete(),
      runningExecutionStartedAt: FieldValue.delete(),
      lastExecutionStatus: status,
      lastExecutionAt: now,
      ...(error ? { lastError: error.slice(0, 4000) } : { lastError: FieldValue.delete() }),
      ...(retryState ? { retryState } : { retryState: FieldValue.delete() }),
      ...(oneShot ? { enabled: false } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(runRef, {
      status,
      completedAt: now,
      ...(error ? { error: error.slice(0, 4000) } : {}),
      slot,
      scheduleId,
      userId,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  // Notification « toujours actif » : l'utilisateur est prévenu sur son canal
  // de messagerie configuré — best effort, jamais bloquant.
  void notifyScheduleRunCompleted({
    userId,
    scheduleId,
    status,
    error,
  });
}

export async function listScheduleRuns(userId: string, scheduleId: string, limit = 25) {
  const schedule = await getSchedule(userId, scheduleId);
  if (!schedule) return null;

  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const snap = await adminDb
    .collection(RUNS_COLLECTION)
    .where("scheduleId", "==", scheduleId)
    .limit(Math.min(100, safeLimit * 2))
    .get();

  return snap.docs
    .filter((doc) => doc.data().userId === userId)
    .slice(0, safeLimit)
    .map((doc) => serializeRun(doc.id, doc.data()))
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

export function serializeSchedule(id: string, data: DocumentData): AgentSchedule {
  const toIso = (value: unknown) => value instanceof Timestamp ? value.toDate().toISOString() : undefined;
  return {
    ...(data as Omit<AgentSchedule, "id">),
    id,
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
    lastExecutionAt: toIso(data.lastExecutionAt),
    runningExecutionStartedAt: toIso(data.runningExecutionStartedAt),
    nextRunAt: typeof data.nextRunAt === "string" ? data.nextRunAt : undefined,
  };
}

function serializeRun(id: string, data: DocumentData): ScheduleRun {
  const toIso = (value: unknown) => value instanceof Timestamp ? value.toDate().toISOString() : undefined;
  return {
    id,
    scheduleId: String(data.scheduleId),
    userId: String(data.userId),
    agentId: String(data.agentId),
    slot: String(data.slot),
    status: String(data.status),
    startedAt: toIso(data.startedAt),
    completedAt: toIso(data.completedAt),
    error: typeof data.error === "string" ? data.error : undefined,
  };
}

export async function dispatchSchedules(now = new Date()) {
  const snap = await adminDb.collection(COLLECTION).where("enabled", "==", true).limit(500).get();
  const all = snap.docs.map((doc) => serializeSchedule(doc.id, doc.data()));
  const due = all.filter((schedule) => isScheduleActive(schedule, now));
  const results: Array<Record<string, unknown>> = [];

  // Cache de statut agent par dispatch : un agent mis en pause (Studio)
  // suspend SES planifications en arrière-plan — reprise instantanée à la
  // réactivation, sans perdre aucun créneau futur.
  const agentStatusCache = new Map<string, string | null>();
  const resolveAgentStatus = async (agentId: string): Promise<string | null> => {
    if (agentStatusCache.has(agentId)) return agentStatusCache.get(agentId) ?? null;
    let status: string | null = null;
    try {
      const agentSnap = await adminDb.collection("agents").doc(agentId).get();
      status = agentSnap.exists ? String((agentSnap.data() as { status?: string }).status ?? "active") : null;
    } catch { status = null; }
    agentStatusCache.set(agentId, status);
    return status;
  };

  for (const schedule of due) {
    const agentStatus = await resolveAgentStatus(schedule.agentId);
    if (agentStatus === "paused" || agentStatus === "archived") {
      results.push({ scheduleId: schedule.id, agentId: schedule.agentId, status: "skipped", reason: `agent ${agentStatus}` });
      continue;
    }
    // RATTRAPAGE (catchUp) : un créneau manqué (indisponibilité passée) est
    // signalé dans le contexte de l'exécution courante — BORNÉ : jamais de
    // rejeu des créneaux intermédiaires (anti-spam d'exécutions).
    const catchUpNote = describeCatchUp(schedule, now);
    const claim = await claimDueSchedule(schedule, now);
    if (!claim) continue;

    try {
      results.push({ scheduleId: schedule.id, ...(await runSchedule(schedule, claim.executionId, claim.slot, catchUpNote)) });
    } catch (error) {
      results.push({
        scheduleId: schedule.id,
        executionId: claim.executionId,
        status: "failed",
        error: error instanceof Error ? error.message : "Scheduled execution failed",
      });
    }
  }

  // ─── RELANCES AUTOMATIQUES (retry après échec) ───
  const retryDue = all.filter((schedule) => {
    const state = schedule.retryState;
    return Boolean(state && typeof state.notBeforeMs === "number" && state.notBeforeMs <= now.getTime());
  });
  for (const schedule of retryDue) {
    const agentStatus = await resolveAgentStatus(schedule.agentId);
    if (agentStatus === "paused" || agentStatus === "archived") continue;
    const claim = await claimRetrySchedule(schedule, now);
    if (!claim) continue;
    const attempt = schedule.retryState?.attempt ?? 1;
    try {
      results.push({
        scheduleId: schedule.id,
        ...(await runSchedule(
          schedule,
          claim.executionId,
          claim.slot,
          `Relance automatique après échec (tentative ${attempt} / ${schedule.maxRetries ?? 0}).`,
        )),
      });
    } catch (error) {
      results.push({
        scheduleId: schedule.id,
        executionId: claim.executionId,
        status: "failed",
        trigger: "retry",
        error: error instanceof Error ? error.message : "Retry execution failed",
      });
    }
  }

  // ─── Agents « toujours actifs » : veille RSS / web ───
  const watchers = all.filter((schedule) => (schedule.watchSources?.length ?? 0) > 0);
  for (const schedule of watchers) {
    try {
      results.push(...(await checkScheduleWatchSources(schedule)));
    } catch (error) {
      results.push({
        scheduleId: schedule.id,
        status: "failed",
        error: error instanceof Error ? error.message : "Watch check failed",
      });
    }
  }

  return { checked: snap.size, due: due.length, executed: results };
}

/**
 * Note de rattrapage : détecte (sans le rejouer) un créneau manqué — le
 * dernier slot exécuté est antérieur au créneau précédent de la fenêtre
 * courante. Retourne une note de contexte bornée, ou undefined.
 */
function describeCatchUp(schedule: AgentSchedule, now: Date): string | undefined {
  if (!schedule.catchUp) return undefined;
  const slot = slotFor(schedule, now);
  const last = schedule.lastTriggeredSlot;
  if (!slot || !last || last === slot) return undefined;
  const [lastDate, lastIdxRaw] = last.split(":");
  const [curDate, curIdxRaw] = slot.split(":");
  const lastIdx = Number(lastIdxRaw?.replace("start", "0") ?? NaN);
  const curIdx = Number(curIdxRaw?.replace("start", "0") ?? NaN);
  if (!Number.isFinite(lastIdx) || !Number.isFinite(curIdx)) return undefined;
  const sameDay = lastDate === curDate;
  const missed = sameDay ? curIdx - lastIdx > 1 : true; // jour différent = fenêtre précédente manquée
  return missed
    ? `Note de rattrapage : le créneau précédent (${last}) a été manqué (indisponibilité). Cette exécution couvre le créneau courant (${slot}).`
    : undefined;
}

/** Claim d'une RELANCE (retry) : exactement-une par transaction, bail
 * d'exécution respecté, état retryState consommé atomiquement. */
async function claimRetrySchedule(schedule: AgentSchedule, now = new Date()): Promise<ClaimedRun | null> {
  const state = schedule.retryState;
  if (!state || state.notBeforeMs > now.getTime()) return null;

  const executionId = randomUUID();
  const slot = `retry:${state.attempt}:${executionId.slice(0, 8)}`;
  const ref = adminDb.collection(COLLECTION).doc(schedule.id);
  const runRef = adminDb.collection(RUNS_COLLECTION).doc(executionId);

  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data()!;
    if (data.userId !== schedule.userId || data.enabled !== true) return null;
    const current = data.retryState as { attempt?: number; notBeforeMs?: number } | undefined;
    if (!current || typeof current.notBeforeMs !== "number" || current.notBeforeMs > now.getTime()) return null;

    const runningStarted = data.runningExecutionStartedAt instanceof Timestamp
      ? data.runningExecutionStartedAt.toDate().getTime()
      : 0;
    const runningActive = Boolean(data.runningExecutionId) && runningStarted > 0 && now.getTime() - runningStarted < EXECUTION_LEASE_MS;
    if (runningActive) return null;

    const startedAt = Timestamp.fromDate(now);
    tx.update(ref, {
      runningExecutionId: executionId,
      runningExecutionStartedAt: startedAt,
      lastExecutionId: executionId,
      lastExecutionStatus: "running",
      retryState: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(runRef, {
      scheduleId: schedule.id,
      userId: schedule.userId,
      agentId: schedule.agentId,
      slot,
      status: "running",
      attempt: current.attempt ?? 1,
      trigger: "retry",
      startedAt,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { executionId, slot };
  });
}


export async function triggerScheduleNow(userId: string, scheduleId: string) {
  const schedule = await getSchedule(userId, scheduleId);
  if (!schedule) throw new Error("Schedule not found");
  if (!schedule.enabled) throw new Error("Schedule is paused");

  const executionId = randomUUID();
  const slot = `manual:${executionId}`;
  const ref = adminDb.collection(COLLECTION).doc(scheduleId);
  const runRef = adminDb.collection(RUNS_COLLECTION).doc(executionId);
  const now = Timestamp.now();

  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.userId !== userId) throw new Error("Schedule not found");

    const data = snap.data()!;
    const runningStarted = data.runningExecutionStartedAt instanceof Timestamp
      ? data.runningExecutionStartedAt.toDate().getTime()
      : 0;
    const runningActive = Boolean(data.runningExecutionId) && runningStarted > 0 &&
      Date.now() - runningStarted < EXECUTION_LEASE_MS;
    if (runningActive) throw new Error("A schedule execution is already running");

    tx.update(ref, {
      runningExecutionId: executionId,
      runningExecutionStartedAt: now,
      lastExecutionId: executionId,
      lastExecutionStatus: "running",
      lastError: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(runRef, {
      scheduleId,
      userId,
      agentId: schedule.agentId,
      slot,
      status: "running",
      startedAt: now,
      trigger: "manual",
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  return runSchedule(schedule, executionId, slot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Agents « toujours actifs » : déclencheurs webhook (événement externe) et
// veille (RSS / web). L'agent poursuit sa mission même quand personne n'est
// connecté, puis notifie l'utilisateur sur son canal de messagerie.
// ─────────────────────────────────────────────────────────────────────────────

/** Réservation d'exécution pour un déclencheur événementiel (webhook / veille). */
async function claimAlwaysOnRun(
  schedule: AgentSchedule,
  slot: string,
  trigger: "webhook" | "watch",
): Promise<{ executionId: string } | null> {
  const executionId = randomUUID();
  const ref = adminDb.collection(COLLECTION).doc(schedule.id);
  const runRef = adminDb.collection(RUNS_COLLECTION).doc(executionId);
  const now = Timestamp.now();

  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;

    const data = snap.data()!;
    if (data.userId !== schedule.userId || data.enabled !== true) return null;

    // Déduplication : un slot déjà traité (même contenu de veille) ne repart pas.
    if (data.lastTriggeredSlot === slot) return null;

    const runningStarted = data.runningExecutionStartedAt instanceof Timestamp
      ? data.runningExecutionStartedAt.toDate().getTime()
      : 0;
    const runningActive = Boolean(data.runningExecutionId) && runningStarted > 0 &&
      Date.now() - runningStarted < EXECUTION_LEASE_MS;
    if (runningActive) return null;

    tx.update(ref, {
      lastTriggeredSlot: slot,
      runningExecutionId: executionId,
      runningExecutionStartedAt: now,
      lastExecutionId: executionId,
      lastExecutionStatus: "running",
      lastError: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(runRef, {
      scheduleId: schedule.id,
      userId: schedule.userId,
      agentId: schedule.agentId,
      slot,
      status: "running",
      startedAt: now,
      trigger,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { executionId };
  });
}

/** Recherche d'une planification par token de webhook entrant. */
async function getScheduleByWebhookToken(token: string): Promise<AgentSchedule | null> {
  const snap = await adminDb.collection(COLLECTION)
    .where("alwaysOnWebhookToken", "==", token)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  const schedule = serializeSchedule(doc.id, doc.data());
  return schedule.enabled ? schedule : null;
}

/**
 * Déclenchement par webhook externe : authentification par token secret,
 * payload transmis à l'agent comme contexte de la mission. L'exécution est
 * lancée en tâche de fond (after) : la réponse HTTP est immédiate.
 */
export async function triggerScheduleByWebhookToken(token: string, payload: unknown): Promise<{ executionId: string; scheduleId: string; accepted: boolean }> {
  const schedule = await getScheduleByWebhookToken(token);
  if (!schedule) throw new Error("Webhook trigger not found or disabled");

  const slot = `webhook:${randomUUID().slice(0, 8)}`;
  const claim = await claimAlwaysOnRun(schedule, slot, "webhook");
  if (!claim) return { executionId: "", scheduleId: schedule.id, accepted: false };

  const payloadNote = payload === undefined || payload === null
    ? undefined
    : `[Déclenché par un webhook externe — payload reçu :]\n${JSON.stringify(payload).slice(0, 4_000)}`;

  // runSchedule termine la réservation (succès/échec) même en cas d'erreur.
  void runSchedule(schedule, claim.executionId, slot, payloadNote).catch(() => undefined);

  return { executionId: claim.executionId, scheduleId: schedule.id, accepted: true };
}

/**
 * Vérifie les sources de veille d'une planification : pour chaque source
 * due (throttlée 10 min), fetch + hash normalisé ; un contenu modifié
 * déclenche l'agent avec le contexte de la source. Retourne le détail.
 */
export async function checkScheduleWatchSources(schedule: AgentSchedule, force = false): Promise<Array<Record<string, unknown>>> {
  const sources = schedule.watchSources ?? [];
  const results: Array<Record<string, unknown>> = [];
  const now = new Date();
  const updatedSources: WatchSource[] = [...sources];

  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    const lastChecked = source.lastCheckedAt ? new Date(source.lastCheckedAt).getTime() : 0;
    if (!force && now.getTime() - lastChecked < WATCH_CHECK_THROTTLE_MS) {
      results.push({ scheduleId: schedule.id, sourceId: source.id, status: "skipped_throttled" });
      continue;
    }

    try {
      const snapshot = await checkWatchSource(source);
      updatedSources[index] = {
        ...source,
        lastHash: snapshot.hash,
        lastCheckedAt: now.toISOString(),
      };

      if (snapshot.firstCheck) {
        // Première sonde : on établit la baseline sans déclencher d'exécution.
        results.push({ scheduleId: schedule.id, sourceId: source.id, status: "baseline_recorded" });
      } else if (snapshot.changed) {
        const slot = `watch:${source.id}:${snapshot.hash.slice(0, 10)}`;
        const claim = await claimAlwaysOnRun(schedule, slot, "watch");
        if (claim) {
          const contextNote = [
            `[Déclenché par la veille « ${source.label || source.url} » (${source.type}) — le contenu surveillé vient de changer.]`,
            `Source : ${source.url}`,
          ].join("\n");
          const outcome = await runSchedule(schedule, claim.executionId, slot, contextNote).catch((error: unknown) => ({
            executionId: claim.executionId,
            status: "failed",
            error: error instanceof Error ? error.message : "Watch execution failed",
          }));
          results.push({
            scheduleId: schedule.id,
            sourceId: source.id,
            watchStatus: "triggered",
            executionId: outcome.executionId,
            runStatus: outcome.status,
          });
        } else {
          results.push({ scheduleId: schedule.id, sourceId: source.id, status: "skipped_busy" });
        }
      } else {
        results.push({ scheduleId: schedule.id, sourceId: source.id, status: "unchanged" });
      }
    } catch (error) {
      updatedSources[index] = { ...source, lastCheckedAt: now.toISOString() };
      results.push({
        scheduleId: schedule.id,
        sourceId: source.id,
        status: "check_failed",
        error: error instanceof Error ? error.message : "Watch source check failed",
      });
    }
  }

  if (updatedSources.some((source, index) => source !== sources[index])) {
    await adminDb.collection(COLLECTION).doc(schedule.id).update({
      watchSources: updatedSources,
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(() => undefined);
  }

  return results;
}

/** Vérification manuelle (bouton « Vérifier la veille ») côté utilisateur. */
export async function checkScheduleWatchSourcesForUser(userId: string, scheduleId: string): Promise<Array<Record<string, unknown>>> {
  const schedule = await getSchedule(userId, scheduleId);
  if (!schedule) throw new Error("Schedule not found");
  if ((schedule.watchSources?.length ?? 0) === 0) throw new Error("This schedule has no watch sources");
  return checkScheduleWatchSources(schedule, true);
}
