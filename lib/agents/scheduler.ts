import { randomUUID } from "crypto";
import { FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore";
import { z } from "zod";

import { adminDb } from "@/lib/firebase/admin";
import { AgentRuntime, RuntimePlanSchema } from "@/lib/agents/runtime";
import { getAgentForOwner } from "@/lib/agents/repository";

export const ScheduleSchema = z.object({
  agentId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(3).max(50_000),
  plan: RuntimePlanSchema.omit({ executionId: true, objective: true }).optional(),
  timezone: z.string().trim().min(1).max(100),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  intervalMinutes: z.number().int().min(0).max(1440).default(0),
  enabled: z.boolean().default(true),
  maxRetries: z.number().int().min(0).max(5).default(2),
  retryDelayMinutes: z.number().int().min(1).max(1440).default(5),
  catchUp: z.boolean().default(false),
  maxCatchUpRuns: z.number().int().min(0).max(10).default(1),
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
  trigger?: "scheduled" | "manual" | "retry" | "catch_up";
};

const COLLECTION = "agentSchedules";
const RUNS_COLLECTION = "agentScheduleRuns";
const EXECUTION_LEASE_MS = 2 * 60 * 60 * 1000;

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
  const base = new Date(now);
  for (let offset = 0; offset <= 8; offset++) {
    const probe = new Date(base.getTime() + offset * 86_400_000);
    const local = localParts(probe, schedule.timezone);
    if (!schedule.daysOfWeek.includes(local.weekday)) continue;
    const start = minutes(schedule.startTime);
    const end = minutes(schedule.endTime);
    const first = new Date(probe);
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
  const local = localParts(now, schedule.timezone);
  const current = local.hour * 60 + local.minute;
  const start = minutes(schedule.startTime);
  const end = minutes(schedule.endTime);

  if (!isScheduleActive(schedule, now)) return null;

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

  const agent = await getAgentForOwner(userId, parsed.agentId);
  if (!agent) throw new Error("Agent not found or not owned by this account");
  if (agent.status !== "active") throw new Error("Only active agents can be scheduled");

  const id = randomUUID();
  const now = FieldValue.serverTimestamp();

  await adminDb.collection(COLLECTION).doc(id).set({
    ...parsed,
    userId,
    daysOfWeek: [...new Set(parsed.daysOfWeek)].sort((a, b) => a - b),
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
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

export async function updateSchedule(userId: string, id: string, input: unknown) {
  const parsed = ScheduleSchema.partial().parse(input);
  if (parsed.timezone) assertTimezone(parsed.timezone);

  const ref = adminDb.collection(COLLECTION).doc(id);
  const current = await ref.get();
  if (!current.exists || current.data()?.userId !== userId) return null;

  if (parsed.agentId) {
    const agent = await getAgentForOwner(userId, parsed.agentId);
    if (!agent || agent.status !== "active") throw new Error("Agent not found, not owned, or inactive");
  }

  await ref.update({
    ...parsed,
    ...(parsed.daysOfWeek ? { daysOfWeek: [...new Set(parsed.daysOfWeek)].sort((a, b) => a - b) } : {}),
    updatedAt: FieldValue.serverTimestamp(),
    nextRunAt: parsed.enabled ? nextOccurrence({ ...parsed, id, userId } as AgentSchedule) : FieldValue.delete(),
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
      nextRunAt: scheduleData.enabled ? nextOccurrence({ ...(scheduleData as Omit<AgentSchedule, "id">), id: scheduleId } as AgentSchedule, now) : FieldValue.delete(),
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

export async function runSchedule(schedule: AgentSchedule, executionId: string, slot: string) {
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

  try {
    const runtime = new AgentRuntime({
      userId: schedule.userId,
      objective: schedule.objective,
      plan: { ...plan, executionId, objective: schedule.objective },
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

    tx.update(scheduleRef, {
      runningExecutionId: FieldValue.delete(),
      runningExecutionStartedAt: FieldValue.delete(),
      lastExecutionStatus: status,
      lastExecutionAt: now,
      ...(error ? { lastError: error.slice(0, 4000) } : { lastError: FieldValue.delete() }),
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
  const due = snap.docs.map((doc) => serializeSchedule(doc.id, doc.data())).filter((schedule) => isScheduleActive(schedule, now));
  const results: Array<Record<string, unknown>> = [];

  for (const schedule of due) {
    const claim = await claimDueSchedule(schedule, now);
    if (!claim) continue;

    try {
      results.push({ scheduleId: schedule.id, ...(await runSchedule(schedule, claim.executionId, claim.slot)) });
    } catch (error) {
      results.push({
        scheduleId: schedule.id,
        executionId: claim.executionId,
        status: "failed",
        error: error instanceof Error ? error.message : "Scheduled execution failed",
      });
    }
  }

  return { checked: snap.size, due: due.length, executed: results };
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
