import { adminDb } from "@/lib/firebase/admin";
import type { LiveAction, LivePermission, LivePendingAction, LiveRuntimeState, LiveSession, LiveSessionMode, LiveSessionStatus } from "./types";

const COLLECTION = "liveAgentSessions";
const PENDING_ACTION_MAX_AGE_MS = 10 * 60_000;
const DEFAULT_MAX_ITERATIONS = 10_000;

function ref(id: string) {
  return adminDb.collection(COLLECTION).doc(id);
}

export async function createLiveSession(input: { id: string; ownerId: string; name: string; objective: string; permissions: LivePermission[]; expiresAt?: number; pairingTokenHash: string; viewerTokenHash?: string; mode?: LiveSessionMode; }): Promise<LiveSession> {
  const now = Date.now();
  const runtime: LiveRuntimeState = { status: "idle", iteration: 0, maxIterations: DEFAULT_MAX_ITERATIONS };
  const session: LiveSession = { id: input.id, ownerId: input.ownerId, name: input.name, objective: input.objective, status: "pending", permissions: input.permissions, createdAt: now, updatedAt: now, expiresAt: input.expiresAt, version: 1, runtime, ...(input.mode ? { mode: input.mode } : {}) };
  await ref(input.id).set({ ...session, pairingTokenHash: input.pairingTokenHash, ...(input.viewerTokenHash ? { viewerTokenHash: input.viewerTokenHash } : {}) });
  return session;
}

export async function getLiveSession(id: string): Promise<(LiveSession & { pairingTokenHash: string }) | null> {
  const snap = await ref(id).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  return { ...(data as LiveSession), createdAt: typeof data.createdAt === "number" ? data.createdAt : Date.now(), updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : Date.now(), pairingTokenHash: String(data.pairingTokenHash ?? ""), viewerTokenHash: String(data.viewerTokenHash ?? "") };
}

export async function assertLiveSessionOwner(id: string, ownerId: string) {
  const session = await getLiveSession(id);
  if (!session || session.ownerId !== ownerId) throw new Error("Live session access denied");
  return session;
}

export async function updateLiveSessionStatus(id: string, status: LiveSessionStatus, deviceId?: string) {
  const now = Date.now();
  const runtimeStatus = status === "stopped" ? "stopped" : status === "failed" ? "failed" : status === "paused" ? "paused" : status === "running" ? "running" : undefined;
  await ref(id).update({ status, ...(deviceId ? { deviceId } : {}), ...(runtimeStatus ? { "runtime.status": runtimeStatus } : {}), updatedAt: now, version: now });
}

export async function heartbeatLiveSession(id: string, deviceId: string) {
  const now = Date.now();
  await ref(id).update({ lastHeartbeatAt: now, deviceId, updatedAt: now });
}

export async function startLiveRuntime(id: string, deviceId: string) {
  const sessionRef = ref(id);
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(sessionRef);
    if (!snap.exists) throw new Error("Live session not found");
    const data = snap.data()! as LiveSession;
    if (data.deviceId !== deviceId) throw new Error("Live device is not authorized");
    const now = Date.now();
    const runtime: LiveRuntimeState = { ...(data.runtime ?? { status: "idle", iteration: 0, maxIterations: DEFAULT_MAX_ITERATIONS }), status: "running", startedAt: data.runtime?.startedAt ?? now, error: undefined };
    tx.update(sessionRef, { runtime, updatedAt: now, version: now });
    return runtime;
  });
}

export async function recordLiveObservation(id: string, input: { deviceId: string; decisionMessage: string; done: boolean; actionId?: string; }) {
  const sessionRef = ref(id);
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(sessionRef);
    if (!snap.exists) throw new Error("Live session not found");
    const data = snap.data()! as LiveSession;
    if (data.deviceId !== input.deviceId) throw new Error("Live device is not authorized");
    const runtime = data.runtime ?? { status: "running", iteration: 0, maxIterations: DEFAULT_MAX_ITERATIONS };
    const now = Date.now();
    const iteration = runtime.iteration + 1;
    if (iteration > runtime.maxIterations) throw new Error("Live runtime iteration budget exhausted");
    const next: LiveRuntimeState = { ...runtime, status: input.done ? "completed" : "running", iteration, lastObservationAt: now, lastDecisionMessage: input.decisionMessage.slice(0, 2000), ...(input.actionId ? { lastActionId: input.actionId } : {}), ...(input.done ? { completedAt: now } : {}), error: undefined };
    tx.update(sessionRef, { runtime: next, updatedAt: now, version: now });
    return next;
  });
}

export async function recordLiveRuntimeActionResult(id: string, input: { deviceId: string; actionId: string; ok: boolean; error?: string; }) {
  const sessionRef = ref(id);
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(sessionRef);
    if (!snap.exists) throw new Error("Live session not found");
    const data = snap.data()! as LiveSession;
    if (data.deviceId !== input.deviceId) throw new Error("Live device is not authorized");
    if (data.runtime?.lastActionId && data.runtime.lastActionId !== input.actionId) throw new Error("Live runtime action mismatch");
    const now = Date.now();
    tx.update(sessionRef, { "runtime.lastActionResult": { ok: input.ok, ...(input.error ? { error: input.error.slice(0, 2000) } : {}), at: now }, updatedAt: now, version: now });
  });
}

export async function setLiveRuntimeWaitingConfirmation(id: string, actionId: string) {
  const now = Date.now();
  await ref(id).update({ "runtime.status": "waiting_confirmation", "runtime.lastActionId": actionId, updatedAt: now, version: now });
}

export async function setLiveRuntimeRecoveryRequired(id: string, actionId: string) {
  const now = Date.now();
  await ref(id).update({ "runtime.status": "recovering", "runtime.lastActionId": actionId, updatedAt: now, version: now });
}

export async function setPendingLiveAction(id: string, pendingAction: LivePendingAction) {
  const now = Date.now();
  await ref(id).update({ pendingAction, status: "paused", "runtime.status": "waiting_confirmation", "runtime.lastActionId": pendingAction.actionId, updatedAt: now, version: now });
}

export async function approvePendingLiveAction(id: string, actionId: string, ownerId: string) {
  const sessionRef = ref(id);
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(sessionRef);
    if (!snap.exists) throw new Error("Live session not found");
    const data = snap.data()! as LiveSession;
    if (data.ownerId !== ownerId) throw new Error("Live session access denied");
    const pending = data.pendingAction;
    if (!pending || pending.actionId !== actionId) throw new Error("Pending live action not found");
    if (pending.approvedAt || pending.sentAt) throw new Error("Live action is no longer pending approval");
    if (Date.now() - pending.createdAt > PENDING_ACTION_MAX_AGE_MS) throw new Error("Live action approval expired");
    if (data.inFlightAction) throw new Error("Another live action is still in flight");
    const approvedAt = Date.now();
    tx.update(sessionRef, { "pendingAction.approvedAt": approvedAt, status: "running", "runtime.status": "running", updatedAt: approvedAt, version: approvedAt });
    return approvedAt;
  });
}

export async function claimApprovedLiveAction(id: string, deviceId: string): Promise<LivePendingAction | null> {
  const sessionRef = ref(id);
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(sessionRef);
    if (!snap.exists) return null;
    const data = snap.data()! as LiveSession;
    const pending = data.pendingAction;
    if (data.deviceId !== deviceId || data.status !== "running" || !pending?.approvedAt || pending.sentAt || data.inFlightAction) return null;
    if (Date.now() - pending.createdAt > PENDING_ACTION_MAX_AGE_MS) {
      const now = Date.now();
      tx.update(sessionRef, { pendingAction: null, status: "paused", "runtime.status": "paused", updatedAt: now, version: now });
      return null;
    }
    const sentAt = Date.now();
    tx.update(sessionRef, { "pendingAction.sentAt": sentAt, updatedAt: sentAt, version: sentAt, inFlightAction: { actionId: pending.actionId, action: pending.action, requestedAt: pending.createdAt, sentAt, deviceId } });
    return { ...pending, sentAt };
  });
}

export async function beginLiveAction(id: string, actionId: string, action: LiveAction, deviceId: string) {
  const sessionRef = ref(id);
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(sessionRef);
    if (!snap.exists) throw new Error("Live session not found");
    const data = snap.data()! as LiveSession;
    if (data.deviceId !== deviceId) throw new Error("Live device is not authorized");
    if (data.status !== "running") throw new Error("Live session is not running");
    if (data.inFlightAction) throw new Error("Another live action is still in flight");
    const now = Date.now();
    tx.update(sessionRef, { inFlightAction: { actionId, action, requestedAt: now, sentAt: now, deviceId }, "runtime.lastActionId": actionId, updatedAt: now, version: now });
  });
}

export async function completeLiveAction(id: string, actionId: string, deviceId: string) {
  const sessionRef = ref(id);
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(sessionRef);
    if (!snap.exists) throw new Error("Live session not found");
    const data = snap.data()! as LiveSession;
    const inFlight = data.inFlightAction;
    if (!inFlight || inFlight.actionId !== actionId || inFlight.deviceId !== deviceId) throw new Error("Unknown or expired live action");
    const now = Date.now();
    tx.update(sessionRef, { inFlightAction: null, pendingAction: null, updatedAt: now, version: now });
  });
}

export async function recoverInFlightLiveAction(id: string, actionId: string, ownerId: string) {
  const sessionRef = ref(id);
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(sessionRef);
    if (!snap.exists) throw new Error("Live session not found");
    const data = snap.data()! as LiveSession;
    if (data.ownerId !== ownerId) throw new Error("Live session access denied");
    const inFlight = data.inFlightAction;
    if (!inFlight || inFlight.actionId !== actionId) throw new Error("In-flight live action not found");
    const now = Date.now();
    const pending: LivePendingAction = { actionId: inFlight.actionId, action: inFlight.action, createdAt: now, approvedAt: now };
    tx.update(sessionRef, { inFlightAction: null, pendingAction: pending, status: "running", "runtime.status": "recovering", updatedAt: now, version: now });
    return pending;
  });
}

export async function clearPendingLiveAction(id: string, actionId: string) {
  const sessionRef = ref(id);
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(sessionRef);
    if (!snap.exists) return;
    const data = snap.data()! as LiveSession;
    if (data.pendingAction?.actionId !== actionId && data.inFlightAction?.actionId !== actionId) return;
    tx.update(sessionRef, { pendingAction: null, inFlightAction: null, updatedAt: Date.now(), version: Date.now() });
  });
}

export async function recordLiveEvent(id: string, event: Record<string, unknown>) {
  await ref(id).collection("events").add({ ...event, createdAt: Date.now() });
}

export async function listLiveSessions(ownerId: string, limit = 20): Promise<LiveSession[]> {
  const snap = await adminDb
    .collection(COLLECTION)
    .where("ownerId", "==", ownerId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((doc) => {
    const data = doc.data() as LiveSession & { pairingTokenHash?: string; viewerTokenHash?: string };
    const { pairingTokenHash: _pairingTokenHash, viewerTokenHash: _viewerTokenHash, ...publicSession } = data;
    return publicSession;
  });
}
