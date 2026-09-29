import screenshot from "screenshot-desktop";
import { imageSize } from "image-size";
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import { Button, Key, Point, keyboard, mouse } from "@nut-tree/nut-js";
import WebSocket from "ws";
import { z } from "zod";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const gatewayUrl = process.env.GEN3IA_LIVE_GATEWAY_URL;
const sessionId = process.env.GEN3IA_LIVE_SESSION_ID;
const pairingToken = process.env.GEN3IA_LIVE_PAIRING_TOKEN;
const deviceId = process.env.GEN3IA_LIVE_DEVICE_ID;
const stateFile = process.env.GEN3IA_LIVE_STATE_FILE || ".gen3ia-live-state.json";
const emergencyStopFile = process.env.GEN3IA_LIVE_STOP_FILE || ".gen3ia-live-stop";
const fileRoot = process.env.GEN3IA_LIVE_FILE_ROOT;
if (!gatewayUrl || !sessionId || !pairingToken || !deviceId) throw new Error("GEN3IA Live identity variables are required.");
if (!fileRoot) throw new Error("GEN3IA_LIVE_FILE_ROOT is required for file capabilities.");

const parsedGatewayUrl = new URL(gatewayUrl);
const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(parsedGatewayUrl.hostname);
if (parsedGatewayUrl.protocol !== "wss:" && !(isLoopback && parsedGatewayUrl.protocol === "ws:")) throw new Error("Gen3ia Live requires wss:// in non-local environments.");
if (pairingToken.length < 32 || deviceId.length > 256 || sessionId.length > 128) throw new Error("Invalid Gen3ia Live identity.");

const MAX_FRAME_BYTES = 1_500_000;
const MAX_FILE_BYTES = 2_000_000;
const DEFAULT_FRAME_INTERVAL_MS = 900;
const MAX_COMPLETED_ACTIONS = 1000;
const EMERGENCY_STOP_POLL_MS = 500;

const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mouse.move"), x: z.number().finite().min(0).max(100000), y: z.number().finite().min(0).max(100000) }),
  z.object({ type: z.literal("mouse.click"), button: z.enum(["left", "middle", "right"]) }),
  z.object({ type: z.literal("keyboard.type"), text: z.string().max(10000) }),
  z.object({ type: z.literal("keyboard.key"), key: z.string().min(1).max(64) }),
  z.object({ type: z.literal("wait"), ms: z.number().int().min(50).max(30000) }),
  z.object({ type: z.literal("file.read"), path: z.string().trim().min(1).max(2048) }),
  z.object({ type: z.literal("file.write"), path: z.string().trim().min(1).max(2048), content: z.string().max(MAX_FILE_BYTES) }),
]);
type CompletedAction = { actionId: string; ok: true; completedAt: number };
let completedActions = new Map<string, CompletedAction>();

function safeFilePath(requestedPath: string): string {
  if (!requestedPath || requestedPath.includes("\0") || requestedPath.includes("\\") || requestedPath.split("/").includes("..")) throw new Error("Unsafe live file path.");
  const root = path.resolve(fileRoot!);
  const resolved = path.resolve(root, requestedPath);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Live file path escapes the authorized root.");
  return resolved;
}

async function loadActionJournal() {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as { sessionId?: string; actions?: CompletedAction[] };
    if (parsed.sessionId !== sessionId || !Array.isArray(parsed.actions)) return;
    completedActions = new Map(parsed.actions.filter((item) => z.string().uuid().safeParse(item?.actionId).success).slice(-MAX_COMPLETED_ACTIONS).map((item) => [item.actionId, item]));
  } catch { completedActions = new Map(); }
}

async function persistActionJournal() {
  const temporary = `${stateFile}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, sessionId, deviceId, actions: [...completedActions.values()].slice(-MAX_COMPLETED_ACTIONS) }), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, stateFile);
}

async function emergencyStopRequested() {
  try { await readFile(emergencyStopFile); return true; } catch { return false; }
}

function keyFromString(value: string): Key | null {
  const keys: Record<string, Key> = { Enter: Key.Enter, Escape: Key.Escape, Tab: Key.Tab, Backspace: Key.Backspace, Delete: Key.Delete, ArrowUp: Key.Up, ArrowDown: Key.Down, ArrowLeft: Key.Left, ArrowRight: Key.Right, Home: Key.Home, End: Key.End, PageUp: Key.PageUp, PageDown: Key.PageDown, Space: Key.Space, Control: Key.LeftControl, Shift: Key.LeftShift, Alt: Key.LeftAlt };
  return keys[value] ?? null;
}

async function executeAction(rawAction: unknown): Promise<unknown> {
  if (stopped || paused || await emergencyStopRequested()) throw new Error("Local emergency stop is active.");
  const action = ActionSchema.parse(rawAction);
  switch (action.type) {
    case "mouse.move": await mouse.setPosition(new Point(action.x, action.y)); return;
    case "mouse.click": await mouse.click(action.button === "right" ? Button.RIGHT : action.button === "middle" ? Button.MIDDLE : Button.LEFT); return;
    case "keyboard.type": await keyboard.type(action.text); return;
    case "keyboard.key": {
      const key = keyFromString(action.key);
      if (!key) throw new Error(`Unsupported keyboard key: ${action.key}`);
      await keyboard.pressKey(key); return;
    }
    case "wait": await new Promise((resolve) => setTimeout(resolve, action.ms)); return;
    case "file.read": {
      const target = safeFilePath(action.path);
      const metadata = await stat(target);
      if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) throw new Error("Live file is missing, not regular, or exceeds the size limit.");
      return { path: action.path, content: await readFile(target, "utf8") };
    }
    case "file.write": {
      const target = safeFilePath(action.path);
      await writeFile(target, action.content, { encoding: "utf8", flag: "w" });
      return { path: action.path, bytes: Buffer.byteLength(action.content, "utf8") };
    }
  }
}

let socket: WebSocket | null = null;
let heartbeatTimer: NodeJS.Timeout | undefined;
let captureTimer: NodeJS.Timeout | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let emergencyStopTimer: NodeJS.Timeout | undefined;
let reconnectDelay = 1000;
let stopped = false;
let paused = false;
let frameIntervalMs = DEFAULT_FRAME_INTERVAL_MS;

function send(message: unknown) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function stopCapture() { if (captureTimer) clearInterval(captureTimer); captureTimer = undefined; }
function startCapture() { if (stopped || paused || captureTimer) return; captureTimer = setInterval(() => void captureAndSend(), frameIntervalMs); void captureAndSend(); }

async function captureAndSend() {
  if (stopped || paused || socket?.readyState !== WebSocket.OPEN) return;
  try {
    let jpeg = await screenshot({ format: "jpg" });
    // Task 45 : sur écran 4K, le JPEG natif dépasse souvent la limite — au
    // lieu de perdre la frame EN SILENCE (l'agent ne voyait plus rien), elle
    // est réduite (downscale 1/2 + qualité 70, jusqu'à 3 passes).
    let shrunk = false;
    if (jpeg.length > MAX_FRAME_BYTES) {
      const reduced = shrinkJpeg(jpeg);
      if (!reduced) {
        console.warn("Gen3ia Live: frame trop lourde même après réduction — ignorée.");
        return;
      }
      jpeg = reduced;
      shrunk = true;
    }
    const dimensions = imageSize(jpeg);
    if (!dimensions.width || !dimensions.height) return;
    if (shrunk) console.log(`Gen3ia Live: frame réduite à ${Math.round(jpeg.length / 1024)} Ko pour respecter la limite du gateway.`);
    send({ type: "frame", sessionId, deviceId, timestamp: Date.now(), width: dimensions.width, height: dimensions.height, jpegBase64: jpeg.toString("base64") });
  } catch (error) { console.error("screen capture failed", error); }
}

/** Downscale 1/2 par passes successives (rééchantillonnage 2x2 moyen) + réencodage JPEG qualité 70. */
function shrinkJpeg(input: Buffer): Buffer | null {
  let current = input;
  for (let pass = 0; pass < 3; pass += 1) {
    const decoded = decodeJpeg(new Uint8Array(current), { useTArray: true });
    const halfWidth = Math.max(1, Math.floor(decoded.width / 2));
    const halfHeight = Math.max(1, Math.floor(decoded.height / 2));
    const out = new Uint8Array(halfWidth * halfHeight * 4);
    for (let y = 0; y < halfHeight; y += 1) {
      for (let x = 0; x < halfWidth; x += 1) {
        const srcIdx = (y * 2 * decoded.width + x * 2) * 4;
        const dstIdx = (y * halfWidth + x) * 4;
        out[dstIdx] = decoded.data[srcIdx];
        out[dstIdx + 1] = decoded.data[srcIdx + 1];
        out[dstIdx + 2] = decoded.data[srcIdx + 2];
        out[dstIdx + 3] = 255;
      }
    }
    const encoded = encodeJpeg(out, halfWidth, halfHeight, { quality: 70 });
    current = Buffer.from(encoded.data);
    if (current.length <= MAX_FRAME_BYTES) return current;
  }
  return null;
}

function activateEmergencyStop(reason: string) {
  if (stopped) return;
  stopped = true; paused = true; stopCapture();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  heartbeatTimer = undefined; reconnectTimer = undefined;
  socket?.close(4000, "Emergency stop"); socket = null;
  console.warn(`Gen3ia Live Agent emergency stopped: ${reason}`);
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

function connect() {
  if (stopped) return;
  socket = new WebSocket(gatewayUrl!, { maxPayload: 2_000_000 });
  socket.on("open", () => { reconnectDelay = 1000; send({ type: "hello", sessionId, deviceId, pairingToken }); });
  socket.on("message", async (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "hello.ack") {
        const heartbeatInterval = Number(message.heartbeatIntervalMs);
        frameIntervalMs = Math.max(DEFAULT_FRAME_INTERVAL_MS, Number(message.frameIntervalMs) || DEFAULT_FRAME_INTERVAL_MS);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => send({ type: "heartbeat", sessionId, deviceId, timestamp: Date.now() }), Number.isFinite(heartbeatInterval) && heartbeatInterval >= 5000 ? heartbeatInterval : 15000);
        paused = false; startCapture(); return;
      }
      if (message.type === "action") {
        const actionId = typeof message.actionId === "string" ? message.actionId : "";
        if (!z.string().uuid().safeParse(actionId).success) throw new Error("Gateway returned an invalid action identifier.");
        if (completedActions.has(actionId)) { send({ type: "action.result", sessionId, actionId, ok: true }); return; }
        try {
          const result = await executeAction(message.action);
          completedActions.set(actionId, { actionId, ok: true, completedAt: Date.now() });
          if (completedActions.size > MAX_COMPLETED_ACTIONS) completedActions.delete(completedActions.keys().next().value!);
          await persistActionJournal().catch((error) => console.error("failed to persist live action journal", error));
          send({ type: "action.result", sessionId, actionId, ok: true, result });
        } catch (error) {
          send({ type: "action.result", sessionId, actionId, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (message.type === "pause") { paused = true; stopCapture(); return; }
      if (message.type === "resume") { if (await emergencyStopRequested()) return activateEmergencyStop("Local stop file is present."); paused = false; startCapture(); return; }
      if (message.type === "stop") activateEmergencyStop(String(message.reason || "No reason provided"));
    } catch (error) { console.error("invalid gateway message", error); }
  });
  socket.on("close", () => { if (heartbeatTimer) clearInterval(heartbeatTimer); stopCapture(); heartbeatTimer = undefined; scheduleReconnect(); });
  socket.on("error", (error) => console.error("live gateway error", error.message));
}

emergencyStopTimer = setInterval(() => { void emergencyStopRequested().then((requested) => { if (requested) activateEmergencyStop("Local stop file is present."); }); }, EMERGENCY_STOP_POLL_MS);
process.on("SIGINT", () => activateEmergencyStop("SIGINT"));
process.on("SIGTERM", () => activateEmergencyStop("SIGTERM"));

void loadActionJournal().then(async () => {
  if (await emergencyStopRequested()) { activateEmergencyStop("Local stop file is present."); return; }
  connect();
}).catch((error) => { console.error("failed to initialize live action journal", error); process.exit(1); });
