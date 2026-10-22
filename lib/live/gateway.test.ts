import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

/**
 * Gateway Live (mode desktop, WebSocket) — restauration post-Task 150.
 *
 * La surface copilote (copilot-agent) reste RETIRÉE : le contrat vérrouillé
 * ici est le rejet EXPLICITE des messages copilote.* (jamais un crash muet),
 * l'authentification pairing token (hello → hello.ack + session running),
 * et la fermeture 4003 sur token invalide.
 */

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: vi.fn() },
}));

vi.mock("@/lib/live/repository", () => ({
  beginLiveAction: vi.fn(),
  claimApprovedLiveAction: vi.fn(),
  clearPendingLiveAction: vi.fn(),
  completeLiveAction: vi.fn(),
  getLiveSession: vi.fn(),
  heartbeatLiveSession: vi.fn(),
  HEARTBEAT_INTERVAL_MS: 30_000,
  recordLiveEvent: vi.fn(),
  recordLiveObservation: vi.fn(),
  recordLiveRuntimeActionResult: vi.fn(),
  setLiveRuntimeRecoveryRequired: vi.fn(),
  setPendingLiveAction: vi.fn(),
  startLiveRuntime: vi.fn(),
  updateLiveSessionStatus: vi.fn(),
}));

import { getLiveSession, recordLiveEvent, startLiveRuntime, updateLiveSessionStatus } from "@/lib/live/repository";
import { hashPairingToken } from "./security";
import type { LiveSession } from "./types";
import { startLiveGateway } from "./gateway";
import type { WebSocketServer } from "ws";

const PAIRING_TOKEN = "pairing-token-test-0123456789abcdef";
const DEVICE_ID = "desktop-test-device";

const mockedGet = vi.mocked(getLiveSession);
const mockedStatus = vi.mocked(updateLiveSessionStatus);
const mockedRuntime = vi.mocked(startLiveRuntime);
const mockedEvent = vi.mocked(recordLiveEvent);

function sessionFixture(overrides: Partial<LiveSession> = {}): LiveSession & { pairingTokenHash: string } {
  return {
    id: "live_gw_test",
    ownerId: "user-1",
    name: "Test gateway",
    objective: "Ouvrir la calculatrice",
    status: "pending",
    permissions: ["screen.read", "input.mouse", "input.keyboard"],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 1,
    expiresAt: Date.now() + 60_000,
    pairingTokenHash: hashPairingToken(PAIRING_TOKEN),
    ...overrides,
  };
}

interface WsClient {
  ws: WebSocket;
  waitFor: (predicate: (message: Record<string, unknown>) => boolean, label: string) => Promise<Record<string, unknown>>;
  closeInfo: Promise<{ code: number; reason: string }>
  send: (payload: unknown) => void;
  close: () => void;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (error) => reject(error));
    ws.once("close", (code) => reject(new Error(`socket fermé avant ouverture (${code})`)));
  });
}

function connect(port: number): WsClient {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const received: Record<string, unknown>[] = [];
  const waiters: Array<{ predicate: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];

  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as Record<string, unknown>;
    received.push(message);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate(message)) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(message);
        waiters.splice(i, 1);
      }
    }
  });

  let resolveClosed: (info: { code: number; reason: string }) => void = () => undefined;
  const closeInfo = new Promise<{ code: number; reason: string }>((resolve) => {
    resolveClosed = resolve;
  });
  ws.on("close", (code, reason) => {
    resolveClosed({ code, reason: reason.toString() });
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`socket fermé en attendant le message (${waiter.label})`));
    }
  });

  return {
    ws,
    closeInfo,
    waitFor: (predicate, label) => {
      const already = received.find(predicate);
      if (already) return Promise.resolve(already);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`message attendu non reçu : ${label}`)), 2_000);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
    send: async (payload) => {
      await waitForOpen(ws);
      ws.send(JSON.stringify(payload));
      // Laisse la boucle serveur traiter le message.
      await new Promise((resolve) => setImmediate(resolve));
    },
    close: () => ws.close(),
  };
}

let server: WebSocketServer | null = null;
let port = 0;

beforeEach(() => {
  vi.clearAllMocks();
  server = startLiveGateway(0);
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  expect(port).toBeGreaterThan(0);
});

afterEach(() => {
  for (const client of clients) client.close();
  clients.length = 0;
  server?.close();
  server = null;
});

const clients: WsClient[] = [];

describe("gateway live — protocole WebSocket", () => {
  it("hello valide : session running, runtime démarré, hello.ack renvoyé", async () => {
    mockedGet.mockResolvedValue(sessionFixture() as never);
    mockedStatus.mockResolvedValue(undefined as never);
    mockedRuntime.mockResolvedValue({ status: "running", iteration: 0, maxIterations: 300 } as never);
    mockedEvent.mockResolvedValue(undefined as never);

    const client = connect(port);
    clients.push(client);
    await client.send({ type: "hello", sessionId: "live_gw_test", deviceId: DEVICE_ID, pairingToken: PAIRING_TOKEN });

    const ack = await client.waitFor((m) => m.type === "hello.ack", "hello.ack");
    expect(ack).toMatchObject({ type: "hello.ack", sessionId: "live_gw_test", heartbeatIntervalMs: 30_000, frameIntervalMs: 900 });
    expect(mockedStatus).toHaveBeenCalledWith("live_gw_test", "running", DEVICE_ID);
    expect(mockedRuntime).toHaveBeenCalledWith("live_gw_test", DEVICE_ID);
    expect(mockedEvent).toHaveBeenCalledWith("live_gw_test", expect.objectContaining({ type: "connected", deviceId: DEVICE_ID }));
  }, 10_000);

  it("pairing token invalide : fermeture 4003 (échec authentification)", async () => {
    mockedGet.mockResolvedValue(sessionFixture() as never);
    const client = connect(port);
    clients.push(client);
    await client.send({ type: "hello", sessionId: "live_gw_test", deviceId: DEVICE_ID, pairingToken: "x".repeat(40) });
    const closed = await Promise.race([
      client.closeInfo,
      new Promise((_, reject) => setTimeout(() => reject(new Error("fermeture attendue")), 2_000)),
    ]);
    expect(closed.code).toBe(4003);
  });

  it("messages copilote : rejet explicite (surface retirée Task 150, fermeture 4003)", async () => {
    const client = connect(port);
    clients.push(client);
    await client.send({ type: "copilot.hello", sessionId: "live_gw_test", deviceId: DEVICE_ID, pairingToken: PAIRING_TOKEN });
    const closed = await Promise.race([
      client.closeInfo,
      new Promise((_, reject) => setTimeout(() => reject(new Error("fermeture attendue")), 2_000)),
    ]);
    // La passerelle ne simule JAMAIS un copilote : les messages copilote.*
    // sont rejetés avant toute authentification (surface retirée).
    expect(closed.code).toBe(4003);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("hello avec session expirée : fermeture 4003", async () => {
    mockedGet.mockResolvedValue(sessionFixture({ expiresAt: Date.now() - 1000 }) as never);
    const client = connect(port);
    clients.push(client);
    await client.send({ type: "hello", sessionId: "live_gw_test", deviceId: DEVICE_ID, pairingToken: PAIRING_TOKEN });
    const closed = await Promise.race([
      client.closeInfo,
      new Promise((_, reject) => setTimeout(() => reject(new Error("fermeture attendue")), 2_000)),
    ]);
    expect(closed.code).toBe(4003);
  });
});
