import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests du pont Sentry client (Task 40) : file synchrone bornée, capture
 * via boundaries, rejeu du SDK, idempotence. Environnement node avec un
 * stub de window minimal (aucune dépendance jsdom) — le SDK
 * @sentry/nextjs est mocké (poids, effets de bord).
 */

const captureExceptionMock = vi.fn();
const captureMessageMock = vi.fn();
const initMock = vi.fn();

vi.mock("@sentry/nextjs", () => ({
  init: (...a: unknown[]) => initMock(...(a as [])),
  captureException: (...a: unknown[]) => captureExceptionMock(...(a as [])),
  captureMessage: (...a: unknown[]) => captureMessageMock(...(a as [])),
}));

interface Listener {
  (event: { error?: unknown; reason?: unknown }): void;
}

/** Stub window minimal : enregistrement/dispatch manuel des listeners. */
function makeWindowStub() {
  const listeners = new Map<string, Listener[]>();
  const removed = new Map<string, number>();
  const win: {
    __g3Sentry?: unknown;
    addEventListener: (type: string, fn: Listener) => void;
    removeEventListener: (type: string, fn: Listener) => void;
    dispatch: (type: string, event: { error?: unknown; reason?: unknown }) => void;
  } = {
    __g3Sentry: undefined,
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      const index = list.indexOf(fn);
      if (index >= 0) {
        list.splice(index, 1);
        removed.set(type, (removed.get(type) ?? 0) + 1);
      }
    },
    dispatch(type, event) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
  return { win, removed };
}

let current: ReturnType<typeof makeWindowStub>;

beforeEach(() => {
  vi.useFakeTimers();
  captureExceptionMock.mockClear();
  captureMessageMock.mockClear();
  initMock.mockClear();
  current = makeWindowStub();
  vi.stubGlobal("window", current.win);
  vi.stubGlobal("requestIdleCallback", undefined);
  return () => vi.unstubAllGlobals();
});

import { captureClientException, installSentryBridge } from "./sentry-bridge-client";

async function sdkLoaded(): Promise<void> {
  // Sans requestIdleCallback, le pont retombe sur setTimeout(…, 1500).
  await vi.runAllTimersAsync();
}

describe("pont Sentry client (file synchrone + SDK asynchrone)", () => {
  it("installe le pont et rejoue les erreurs globales pré-init", async () => {
    installSentryBridge();
    const err = new Error("hydratation cassée");
    current.win.dispatch("error", { error: err });

    const bridge = current.win.__g3Sentry as { queue: unknown[]; ready: boolean };
    expect(bridge).toBeDefined();
    expect(bridge.queue).toHaveLength(1);
    expect(captureExceptionMock).not.toHaveBeenCalled(); // SDK pas encore chargé

    await sdkLoaded();
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock.mock.calls[0]![0]).toMatchObject({ tunnel: "/monitoring", sendDefaultPii: false });
    expect(captureExceptionMock).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ tags: expect.objectContaining({ surface: "client-preinit" }) }),
    );
    expect(bridge.queue).toHaveLength(0); // file vidée après rejeu
    expect(bridge.ready).toBe(true);
    // Les listeners globaux sont retirés après init (plus de double capture).
    expect(current.removed.get("error")).toBe(1);
    expect(current.removed.get("unhandledrejection")).toBe(1);
  });

  it("captureClientException (boundaries) passe par la file puis rejoint le SDK avec ses tags", async () => {
    installSentryBridge();
    captureClientException(new Error("boundary route"), { surface: "route-error" });

    await sdkLoaded();
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "route-error" } }),
    );
  });

  it("la file est bornée (25) : un burst sacrifie les plus anciens", async () => {
    installSentryBridge();
    for (let i = 0; i < 40; i++) {
      captureClientException(new Error(`burst-${i}`));
    }
    const bridge = current.win.__g3Sentry as { queue: unknown[] };
    expect(bridge.queue.length).toBeLessThanOrEqual(25);

    await sdkLoaded();
    // burst-0..14 sacrifiés ; burst-15..39 rejoués (25 captures).
    expect(captureExceptionMock.mock.calls.length).toBe(25);
  });

  it("les rejets de promesse pré-init deviennent des messages warning", async () => {
    installSentryBridge();
    current.win.dispatch("unhandledrejection", { reason: "chaîne brute" });
    await sdkLoaded();
    expect(captureMessageMock).toHaveBeenCalledWith(
      "rejet de promesse pré-init",
      expect.objectContaining({ level: "warning" }),
    );
  });

  it("double installation : idempotent (une seule init)", async () => {
    installSentryBridge();
    installSentryBridge();
    await sdkLoaded();
    expect(initMock).toHaveBeenCalledTimes(1);
  });

  it("échec de chargement du SDK : silencieux, la file reste locale", async () => {
    initMock.mockImplementation(() => {
      throw new Error("réseau coupé");
    });
    installSentryBridge();
    current.win.dispatch("error", { error: new Error("avant pannes") });
    await expect(sdkLoaded()).resolves.toBeUndefined(); // pas de crash
  });
});
