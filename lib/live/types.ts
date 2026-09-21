import { z } from "zod";

export const LivePermissionSchema = z.enum([
  "screen.read",
  "input.mouse",
  "input.keyboard",
  "files.read",
  "files.write",
  "browser.control",
]);
export type LivePermission = z.infer<typeof LivePermissionSchema>;

export const LiveSessionStatusSchema = z.enum([
  "pending", "connected", "running", "paused", "disconnected", "stopped", "failed",
]);
export type LiveSessionStatus = z.infer<typeof LiveSessionStatusSchema>;

/**
 * Mode d'exécution de la session Live :
 * - "browser" : le client est le navigateur de l'utilisateur (partage d'écran
 *   natif getDisplayMedia, aucun téléchargement requis). Les actions clavier,
 *   souris et fichiers ne sont pas exécutables — l'agent observe, décrit et
 *   attend.
 * - "desktop" : un client installé (client Node live-agent/) pilote le PC.
 */
export const LiveSessionModeSchema = z.enum(["browser", "desktop"]);
export type LiveSessionMode = z.infer<typeof LiveSessionModeSchema>;

export const LiveRuntimeStatusSchema = z.enum([
  "idle", "running", "waiting_confirmation", "paused", "recovering", "completed", "failed", "stopped",
]);
export type LiveRuntimeStatus = z.infer<typeof LiveRuntimeStatusSchema>;

export interface LiveRuntimeState {
  status: LiveRuntimeStatus;
  iteration: number;
  maxIterations: number;
  startedAt?: number;
  completedAt?: number;
  lastObservationAt?: number;
  lastDecisionMessage?: string;
  lastActionId?: string;
  lastActionResult?: { ok: boolean; error?: string; at: number };
  error?: string;
}

const LivePathSchema = z.string().trim().min(1).max(2048).refine(
  (value) => !value.includes("\\") && !value.includes("\0") && !value.split("/").includes(".."),
  "Unsafe live file path",
);

export const LiveActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mouse.move"), x: z.number().finite().min(0).max(100000), y: z.number().finite().min(0).max(100000) }),
  z.object({ type: z.literal("mouse.click"), button: z.enum(["left", "middle", "right"]).default("left") }),
  z.object({ type: z.literal("keyboard.type"), text: z.string().max(10000) }),
  z.object({ type: z.literal("keyboard.key"), key: z.string().min(1).max(64) }),
  z.object({ type: z.literal("wait"), ms: z.number().int().min(50).max(30000) }),
  z.object({ type: z.literal("file.read"), path: LivePathSchema }),
  z.object({ type: z.literal("file.write"), path: LivePathSchema, content: z.string().max(2_000_000) }),
]);
export type LiveAction = z.infer<typeof LiveActionSchema>;

export interface LivePendingAction {
  actionId: string; action: LiveAction; createdAt: number; approvedAt?: number; sentAt?: number;
}
export interface LiveInFlightAction {
  actionId: string; action: LiveAction; requestedAt: number; sentAt?: number; deviceId: string;
}
export interface LiveSession {
  id: string; ownerId: string; name: string; objective: string; status: LiveSessionStatus;
  permissions: LivePermission[]; deviceId?: string; createdAt: number; updatedAt: number;
  lastHeartbeatAt?: number; expiresAt?: number; version: number; runtime?: LiveRuntimeState;
  pendingAction?: LivePendingAction; inFlightAction?: LiveInFlightAction; viewerTokenHash?: string;
  /** Mode d'exécution ("browser" par défaut pour les nouvelles sessions). */
  mode?: LiveSessionMode;
}

export type LiveClientMessage =
  | { type: "viewer.hello"; sessionId: string; viewerToken: string }
  | { type: "hello"; sessionId: string; deviceId: string; pairingToken: string }
  | { type: "heartbeat"; sessionId: string; deviceId: string; timestamp: number }
  | { type: "frame"; sessionId: string; deviceId: string; timestamp: number; width: number; height: number; jpegBase64: string }
  | { type: "action.result"; sessionId: string; actionId: string; ok: boolean; error?: string; result?: unknown };

export type LiveServerMessage =
  | { type: "hello.ack"; sessionId: string; heartbeatIntervalMs: number; frameIntervalMs: number }
  | { type: "viewer.ack"; sessionId: string; frameIntervalMs: number }
  | { type: "frame"; sessionId: string; deviceId: string; timestamp: number; width: number; height: number; jpegBase64: string }
  | { type: "action"; actionId: string; action: LiveAction }
  | { type: "pause"; reason: string }
  | { type: "resume"; reason: string }
  | { type: "stop"; reason: string };

export const LiveClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("viewer.hello"), sessionId: z.string().min(1).max(128), viewerToken: z.string().min(32).max(256) }),
  z.object({ type: z.literal("hello"), sessionId: z.string().min(1).max(128), deviceId: z.string().min(1).max(256), pairingToken: z.string().min(32).max(256) }),
  z.object({ type: z.literal("heartbeat"), sessionId: z.string().min(1).max(128), deviceId: z.string().min(1).max(256), timestamp: z.number().int().positive() }),
  z.object({ type: z.literal("frame"), sessionId: z.string().min(1).max(128), deviceId: z.string().min(1).max(256), timestamp: z.number().int().positive(), width: z.number().int().min(1).max(10000), height: z.number().int().min(1).max(10000), jpegBase64: z.string().min(1).max(2_000_000) }),
  z.object({ type: z.literal("action.result"), sessionId: z.string().min(1).max(128), actionId: z.string().uuid(), ok: z.boolean(), error: z.string().max(2000).optional(), result: z.unknown().optional() }),
]);
