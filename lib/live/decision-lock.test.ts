import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Verrou de décision vision Live (Task 62) — Task 108 : la garde est
 * PROCESSUS-LOCAL (le service externe Redis a été supprimé du projet) ;
 * sémantique Task 45 restaurée (Map + TTL), `distributed` reste exposé
 * (toujours false) pour la compat d'observabilité.
 */

import {
  acquireDecisionLock,
  getPreviousFramePrint,
  isDecisionInFlight,
  releaseDecisionLock,
  resetDecisionLockForTests,
  setFramePrint,
} from "./decision-lock";

beforeEach(() => {
  resetDecisionLockForTests();
});

describe("verrou de décision (process-local — Task 108)", () => {
  it("acquire → en vol → release → plus en vol", async () => {
    const first = await acquireDecisionLock("sess-1");
    expect(first).toEqual({ acquired: true, distributed: false });

    expect(await isDecisionInFlight("sess-1")).toBe(true);
    const second = await acquireDecisionLock("sess-1");
    expect(second.acquired).toBe(false);

    await releaseDecisionLock("sess-1");
    expect(await isDecisionInFlight("sess-1")).toBe(false);
  });

  it("sessions distinctes : verrous indépendants", async () => {
    expect((await acquireDecisionLock("a")).acquired).toBe(true);
    expect((await acquireDecisionLock("b")).acquired).toBe(true);
  });

  it("empreinte de frame : set puis get", async () => {
    await setFramePrint("sess-2", { hash: "abc", feedbackAt: 123 });
    expect(await getPreviousFramePrint("sess-2")).toEqual({ hash: "abc", feedbackAt: 123 });
    expect(await getPreviousFramePrint("inconnu")).toBeNull();
  });

  it("le verrou expire après son TTL (30 s) — vi.useFakeTimers", async () => {
    vi.useFakeTimers();
    try {
      expect((await acquireDecisionLock("sess-ttl")).acquired).toBe(true);
      vi.advanceTimersByTime(31_000);
      expect(await isDecisionInFlight("sess-ttl")).toBe(false);
      expect((await acquireDecisionLock("sess-ttl")).acquired).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("la dédup d'écran inchangé expire après son TTL (10 min)", async () => {
    vi.useFakeTimers();
    try {
      await setFramePrint("sess-ttl2", { hash: "h1", feedbackAt: 1 });
      expect(await getPreviousFramePrint("sess-ttl2")).toEqual({ hash: "h1", feedbackAt: 1 });
      vi.advanceTimersByTime(10 * 60_000 + 1_000);
      expect(await getPreviousFramePrint("sess-ttl2")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
