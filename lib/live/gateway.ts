import { WebSocketServer, WebSocket } from "ws";
import { createHash, randomUUID } from "node:crypto";
import {
  beginLiveAction,
  claimApprovedLiveAction,
  clearPendingLiveAction,
  completeLiveAction,
  getLiveSession,
  heartbeatLiveSession,
  recordLiveEvent,
  recordLiveObservation,
  recordLiveRuntimeActionResult,
  setLiveRuntimeRecoveryRequired,
  setPendingLiveAction,
  startLiveRuntime,
  updateLiveSessionStatus,
} from "./repository";
import { assertActionAllowed, assertFreshLiveTimestamp, constantTimeEqual, hashPairingToken, LiveAuthFailureLimiter, LiveRateLimiter, validateFrameBase64 } from "./security";
import { actionRequiresConfirmation, decideLiveAction } from "./vision-decider";
import { LiveActionSchema, LiveClientMessageSchema, type LiveClientMessage, type LiveServerMessage } from "./types";

const MAX_FRAME_INTERVAL_MS = 900;
const HEARTBEAT_MS = 15_000;
const SESSION_POLL_MS = 2_000;
const ACTION_RESULT_MAX_AGE_MS = 5 * 60_000;
const MAX_VIEWERS_PER_SESSION = 3;
/** Watchdog (Task 45) : un client muet (ni frame ni heartbeat) est mis en pause. */
const CLIENT_ZOMBIE_MS = 45_000;

interface ConnectionState {
  sessionId: string;
  deviceId: string;
  socket: WebSocket;
  pausedByServer: boolean;
  lastFrameAt: number;
  lastHeartbeatAt: number;
  /** Verrou : une seule décision vision en vol par session (Task 45). */
  decisionInFlight: boolean;
  /** Hash de la dernière frame — dédup des écrans inchangés (Task 45). */
  lastFrameHash?: string;
  /** Timestamp du feedback utilisé par la dernière décision (dédup). */
  lastDecisionFeedbackAt: number;
  lastActionId?: string;
  lastActionResult?: { ok: boolean; error?: string; at: number };
}

const clients = new Map<string, ConnectionState>();
const viewers = new Map<string, Set<WebSocket>>();

function send(socket: WebSocket, message: LiveServerMessage) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

async function authenticateHello(message: Extract<LiveClientMessage, { type: "hello" }>) {
  const session = await getLiveSession(message.sessionId);
  if (!session) throw new Error("Live session not found");
  if (session.expiresAt && session.expiresAt <= Date.now()) throw new Error("Live session expired");
  if (!constantTimeEqual(session.pairingTokenHash, hashPairingToken(message.pairingToken))) throw new Error("Invalid pairing token");
  if (!session.permissions.includes("screen.read")) throw new Error("screen.read permission is required");
  return session;
}

async function authenticateViewer(message: Extract<LiveClientMessage, { type: "viewer.hello" }>) {
  const session = await getLiveSession(message.sessionId);
  if (!session) throw new Error("Live session not found");
  if (session.expiresAt && session.expiresAt <= Date.now()) throw new Error("Live session expired");
  if (session.status === "stopped" || session.status === "failed") throw new Error("Live session is no longer active");
  if (!session.permissions.includes("screen.read")) throw new Error("screen.read permission is required");
  if (!session.viewerTokenHash || !constantTimeEqual(session.viewerTokenHash, hashPairingToken(message.viewerToken))) {
    throw new Error("Invalid viewer token");
  }
  return session;
}

function broadcastFrame(sessionId: string, frame: Extract<LiveServerMessage, { type: "frame" }>) {
  const sockets = viewers.get(sessionId);
  if (!sockets) return;
  for (const socket of sockets) send(socket, frame);
}

async function dispatchApprovedAction(state: ConnectionState): Promise<void> {
  const pending = await claimApprovedLiveAction(state.sessionId, state.deviceId);
  if (!pending) return;
  state.lastActionId = pending.actionId;
  state.lastActionResult = undefined;
  send(state.socket, { type: "action", actionId: pending.actionId, action: pending.action });
  await recordLiveEvent(state.sessionId, { type: "action.requested", actionId: pending.actionId, action: pending.action, approved: true });
}

async function synchronizeConnection(state: ConnectionState): Promise<boolean> {
  const session = await getLiveSession(state.sessionId);
  if (!session || session.deviceId !== state.deviceId) {
    send(state.socket, { type: "stop", reason: "Live device is no longer authorized" });
    state.socket.close(4001, "Unauthorized");
    return false;
  }
  if (session.expiresAt && session.expiresAt <= Date.now()) {
    send(state.socket, { type: "stop", reason: "Live session expired" });
    state.socket.close(4001, "Expired");
    return false;
  }
  if (session.status === "stopped" || session.status === "failed") {
    send(state.socket, { type: "stop", reason: `Live session is ${session.status}` });
    state.socket.close(4000, session.status);
    return false;
  }
  if (session.inFlightAction) {
    if (!state.pausedByServer) {
      state.pausedByServer = true;
      await updateLiveSessionStatus(state.sessionId, "paused", state.deviceId);
      await setLiveRuntimeRecoveryRequired(state.sessionId, session.inFlightAction.actionId);
      send(state.socket, { type: "pause", reason: "An action was interrupted or its result was lost. Explicit retry approval is required." });
      await recordLiveEvent(state.sessionId, { type: "action.recovery_required", actionId: session.inFlightAction.actionId });
    }
    return true;
  }
  if (session.status === "paused") {
    if (!state.pausedByServer) {
      state.pausedByServer = true;
      send(state.socket, { type: "pause", reason: "Live session paused by the user or policy" });
    }
    return true;
  }
  if (state.pausedByServer && session.status === "running") {
    state.pausedByServer = false;
    await startLiveRuntime(state.sessionId, state.deviceId);
    send(state.socket, { type: "resume", reason: "Live session resumed" });
  }
  if (session.status === "running" && session.pendingAction?.approvedAt && !session.pendingAction.sentAt) {
    await dispatchApprovedAction(state);
  }
  return true;
}

export function startLiveGateway(port = Number(process.env.LIVE_GATEWAY_PORT || 8787)) {
  const server = new WebSocketServer({ port, maxPayload: 2_000_000, perMessageDeflate: false });

  server.on("connection", (socket) => {
    let state: ConnectionState | null = null;
    const rateLimiter = new LiveRateLimiter();
    const authFailures = new LiveAuthFailureLimiter();

    socket.on("message", async (raw) => {
      try {
        if (!rateLimiter.allow()) throw new Error("Live protocol rate limit exceeded.");
        const message = LiveClientMessageSchema.parse(JSON.parse(raw.toString()));

        if (message.type === "viewer.hello") {
          const session = await authenticateViewer(message);
          let set = viewers.get(session.id);
          if (set && set.size >= MAX_VIEWERS_PER_SESSION && !set.has(socket)) throw new Error("Live viewer limit reached.");
          if (!set) {
            set = new Set<WebSocket>();
            viewers.set(session.id, set);
          }
          set.add(socket);
          state = null;
          send(socket, { type: "viewer.ack", sessionId: session.id, frameIntervalMs: MAX_FRAME_INTERVAL_MS });
          return;
        }

        if (message.type === "hello") {
          const session = await authenticateHello(message);
          const existing = clients.get(session.id);
          if (existing && existing.socket !== socket) {
            send(existing.socket, { type: "stop", reason: "Replaced by a newer live connection" });
            existing.socket.close(4009, "Replaced");
          }
          const initiallyPaused = session.status === "paused" || Boolean(session.inFlightAction);
          state = { sessionId: session.id, deviceId: message.deviceId, socket, pausedByServer: initiallyPaused, lastFrameAt: 0, lastHeartbeatAt: Date.now(), decisionInFlight: false, lastDecisionFeedbackAt: 0 };
          clients.set(session.id, state);

          if (!initiallyPaused) {
            await updateLiveSessionStatus(session.id, "running", message.deviceId);
            await startLiveRuntime(session.id, message.deviceId);
          } else {
            await updateLiveSessionStatus(session.id, "paused", message.deviceId);
            if (session.inFlightAction) await setLiveRuntimeRecoveryRequired(session.id, session.inFlightAction.actionId);
          }

          await recordLiveEvent(session.id, { type: "connected", deviceId: message.deviceId, recoveryRequired: Boolean(session.inFlightAction) });
          send(socket, { type: "hello.ack", sessionId: session.id, heartbeatIntervalMs: HEARTBEAT_MS, frameIntervalMs: MAX_FRAME_INTERVAL_MS });
          if (session.inFlightAction) {
            send(socket, { type: "pause", reason: "An interrupted action requires explicit retry approval before it can run again." });
          } else if (initiallyPaused) {
            send(socket, { type: "pause", reason: "Live session is paused" });
          }
          return;
        }

        if (!state || message.sessionId !== state.sessionId || ("deviceId" in message && message.deviceId !== state.deviceId)) {
          throw new Error("Unauthenticated live connection");
        }
        if (!(await synchronizeConnection(state))) return;
        if (state.pausedByServer && message.type === "frame") return;

        if (message.type === "heartbeat") {
          assertFreshLiveTimestamp(message.timestamp);
          state.lastHeartbeatAt = Date.now();
          await heartbeatLiveSession(state.sessionId, state.deviceId);
          return;
        }

        if (message.type === "frame") {
          assertFreshLiveTimestamp(message.timestamp);
          const now = Date.now();
          if (now - state.lastFrameAt < MAX_FRAME_INTERVAL_MS) return;
          const jpeg = validateFrameBase64(message.jpegBase64);
          broadcastFrame(state.sessionId, {
            type: "frame",
            sessionId: state.sessionId,
            deviceId: state.deviceId,
            timestamp: message.timestamp,
            width: message.width,
            height: message.height,
            jpegBase64: message.jpegBase64,
          });
          state.lastFrameAt = now;
          state.lastHeartbeatAt = now;

          const session = await getLiveSession(state.sessionId);
          if (!session) throw new Error("Live session not found");
          if (session.inFlightAction) return;

          const feedback = state.lastActionResult && now - state.lastActionResult.at <= ACTION_RESULT_MAX_AGE_MS
            ? state.lastActionResult
            : undefined;

          // Dédup (Task 45) : frame identique à la précédente ET aucun
          // nouveau résultat d'action → l'écran n'a pas changé, la décision
          // précédente reste valable. On économise un appel LLM payant et
          // 2 écritures Firestore par frame (boucles sans évolution).
          const frameHash = createHash("sha256").update(message.jpegBase64).digest("hex");
          const unchanged = frameHash === state.lastFrameHash
            && (feedback ? feedback.at : 0) === state.lastDecisionFeedbackAt;
          state.lastFrameHash = frameHash;
          if (unchanged || state.decisionInFlight) return;

          // Verrou (Task 45) : une décision vision dure 2-5 s — la frame
          // suivante ne relance PAS l'appel LLM pendant ce temps (la course
          // antérieure produisait deux actions et une pause spontanée).
          state.decisionInFlight = true;
          try {
            const decision = await decideLiveAction(session, jpeg, message.width, message.height, feedback);
            const action = decision.action ? LiveActionSchema.parse(decision.action) : undefined;
            const actionId = action ? randomUUID() : undefined;

            state.lastDecisionFeedbackAt = feedback ? feedback.at : 0;

            await recordLiveObservation(state.sessionId, {
              deviceId: state.deviceId,
              decisionMessage: decision.message,
              done: decision.done,
              actionId,
            });
            await recordLiveEvent(state.sessionId, {
              type: "vision.decision",
              message: decision.message,
              done: decision.done,
              action: action ?? null,
            });

            if (decision.done) {
              state.pausedByServer = true;
              await updateLiveSessionStatus(state.sessionId, "connected", state.deviceId);
              send(socket, { type: "pause", reason: "Live objective completed" });
              await recordLiveEvent(state.sessionId, { type: "completed", message: decision.message });
              return;
            }

            if (!action || !actionId) return;
            assertActionAllowed(action, session.permissions);

            if (actionRequiresConfirmation(action)) {
              await setPendingLiveAction(state.sessionId, { actionId, action, createdAt: Date.now() });
              await recordLiveEvent(state.sessionId, { type: "action.blocked", reason: "confirmation_required", actionId, action });
              state.pausedByServer = true;
              send(socket, { type: "pause", reason: "A sensitive action requires explicit confirmation" });
              return;
            }

            await beginLiveAction(state.sessionId, actionId, action, state.deviceId);
            state.lastActionId = actionId;
            state.lastActionResult = undefined;
            await recordLiveEvent(state.sessionId, { type: "action.requested", actionId, action });
            send(socket, { type: "action", actionId, action });
            return;
          } finally {
            state.decisionInFlight = false;
          }
        }

        if (message.type === "action.result") {
          if (state.lastActionId !== message.actionId) throw new Error("Unknown or expired live action");
          await completeLiveAction(state.sessionId, message.actionId, state.deviceId);
          state.lastActionResult = { ok: message.ok, error: message.error, at: Date.now() };
          await recordLiveRuntimeActionResult(state.sessionId, {
            deviceId: state.deviceId,
            actionId: message.actionId,
            ok: message.ok,
            error: message.error,
          });
          await clearPendingLiveAction(state.sessionId, message.actionId);
          await recordLiveEvent(state.sessionId, { type: "action.result", actionId: message.actionId, ok: message.ok, error: message.error });
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Live gateway error";
        if (state) {
          await recordLiveEvent(state.sessionId, { type: "protocol.error", reason }).catch(() => undefined);
          send(socket, { type: "pause", reason });
        } else {
          if (!authFailures.registerFailure()) {
            socket.close(4008, "Too many authentication/protocol failures");
          } else {
            socket.close(4003, "Authentication failed");
          }
        }
      }
    });

    socket.on("close", async () => {
      for (const [sessionId, sockets] of viewers) {
        sockets.delete(socket);
        if (sockets.size === 0) viewers.delete(sessionId);
      }

      if (!state) return;
      if (clients.get(state.sessionId)?.socket === socket) {
        clients.delete(state.sessionId);
        try {
          await updateLiveSessionStatus(state.sessionId, "disconnected", state.deviceId);
          await recordLiveEvent(state.sessionId, { type: "disconnected", deviceId: state.deviceId });
        } catch {
          // cleanup must not crash gateway
        }
      }
    });
  });

  const poller = setInterval(() => {
    const now = Date.now();
    for (const state of clients.values()) {
      // Watchdog (Task 45) : un client sans frame ni heartbeat depuis 45 s
      // est mis en pause — la session ne reste plus « running » des heures
      // avec un client zombie (TTL précédent : 24 h).
      if (!state.pausedByServer && now - Math.max(state.lastFrameAt, state.lastHeartbeatAt) > CLIENT_ZOMBIE_MS) {
        state.pausedByServer = true;
        send(state.socket, { type: "pause", reason: "Aucun signal du client (frames/heartbeat) — session mise en pause automatiquement." });
        void updateLiveSessionStatus(state.sessionId, "paused", state.deviceId).catch(() => undefined);
        void recordLiveEvent(state.sessionId, { type: "protocol.error", reason: "watchdog: client muet" }).catch(() => undefined);
        continue;
      }
      void synchronizeConnection(state).catch((error) =>
        send(state.socket, {
          type: "pause",
          reason: error instanceof Error ? error.message : "Session synchronization failed",
        }),
      );
    }
  }, SESSION_POLL_MS);

  server.on("close", () => clearInterval(poller));
  return server;
}
