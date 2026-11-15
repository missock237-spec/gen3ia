import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createVisibilityPoller } from "./use-visible-polling";

/**
 * Lot C2 (audit perf 2-a) — SONDAGE GATÉ PAR LA VISIBILITÉ.
 *
 * Convention du dépôt (cf. media-progress-frame.test.tsx) : vitest tourne en
 * Node SANS jsdom ni @testing-library/react. La logique de pilotage est donc
 * extraite dans la fabrique PURE `createVisibilityPoller` (horloge et source
 * de visibilité injectées) et testée ici avec une horloge déterministe ; le
 * branchement DOM du hook (visibilitychange, nettoyage, ms = null) est
 * verrouillé structurellement sur la source.
 */

const HOOK = "components/hooks/use-visible-polling.ts";

/** Horloge déterministe : planification manuelle, avance du temps pas à pas
 * (sémantique setInterval : chaque tâche se ré-arme tant qu'elle n'est pas
 * annulée). */
function createTestClock() {
  type Task = { id: number; fn: () => void; ms: number; dueAt: number };
  let nextId = 1;
  let now = 0;
  const tasks = new Map<number, Task>();
  return {
    schedule: (fn: () => void, ms: number) => {
      const id = nextId++;
      tasks.set(id, { id, fn, ms, dueAt: now + ms });
      return id;
    },
    cancel: (timer: unknown) => {
      tasks.delete(timer as number);
    },
    advance: (ms: number) => {
      now += ms;
      // Exécute toutes les tâches dues, dans l'ordre des échéances (les
      // tâches créées pendant l'avancement — reprise d'intervalle — incluses).
      for (;;) {
        const due = [...tasks.values()].filter((t) => t.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt)[0];
        if (!due) break;
        due.dueAt += due.ms; // ré-armement : sémantique setInterval
        due.fn();
      }
    },
    pendingCount: () => tasks.size,
  };
}

/** Source de visibilité contrôlée + compteur d'appels du sondage. */
function createHarness(intervalMs: number, initialVisible: boolean) {
  const clock = createTestClock();
  let visible = initialVisible;
  const listeners = new Set<() => void>();
  const calls: Array<number> = [];
  let counter = 0;
  const poller = createVisibilityPoller({
    intervalMs,
    fn: () => {
      counter += 1;
      calls.push(clock.pendingCount());
    },
    isVisible: () => visible,
    onVisibilityChange: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  return {
    poller,
    calls,
    get counter() {
      return counter;
    },
    pendingCount: clock.pendingCount,
    advance: clock.advance,
    setVisibility(next: boolean) {
      visible = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("createVisibilityPoller — intervalle actif quand l'onglet est visible", () => {
  it("visible au démarrage : intervalle lancé, fn exécutée à chaque échéance", () => {
    const h = createHarness(4_000, true);
    expect(h.poller.isRunning()).toBe(true);
    expect(h.pendingCount()).toBe(1);
    expect(h.counter).toBe(0); // PAS d'appel immédiat : l'appelant garde sa 1re interrogation
    h.advance(4_000);
    expect(h.counter).toBe(1);
    h.advance(8_000);
    expect(h.counter).toBe(3); // 4 s, 8 s, 12 s — intervalle respecté strictement
  });

  it("caché au démarrage : en pause, aucun intervalle ni appel", () => {
    const h = createHarness(2_500, false);
    expect(h.poller.isRunning()).toBe(false);
    expect(h.pendingCount()).toBe(0);
    h.advance(10_000);
    expect(h.counter).toBe(0);
  });

  it("passage en arrière-plan : intervalle annulé, plus aucun appel", () => {
    const h = createHarness(1_000, true);
    h.advance(1_000);
    expect(h.counter).toBe(1);
    h.setVisibility(false);
    expect(h.poller.isRunning()).toBe(false);
    expect(h.pendingCount()).toBe(0);
    h.advance(30_000);
    expect(h.counter).toBe(1);
  });
});

describe("createVisibilityPoller — retour de visibilité", () => {
  it("rafraîchissement IMMÉDIAT au retour puis reprise de l'intervalle", () => {
    const h = createHarness(6_000, false);
    expect(h.counter).toBe(0);
    h.setVisibility(true);
    expect(h.counter).toBe(1); // données fraîches sans attendre le tick
    expect(h.poller.isRunning()).toBe(true);
    expect(h.pendingCount()).toBe(1);
    h.advance(6_000);
    expect(h.counter).toBe(2);
  });

  it("aller-retour caché → visible → caché : une seule exécution immédiate, pause nette", () => {
    const h = createHarness(3_000, true);
    h.setVisibility(false);
    h.setVisibility(true);
    expect(h.counter).toBe(1);
    h.setVisibility(false);
    h.advance(9_000);
    expect(h.counter).toBe(1);
  });
});

describe("createVisibilityPoller — cycle de vie (stop)", () => {
  it("stop annule l'intervalle et désabonne la visibilité", () => {
    const h = createHarness(1_000, true);
    h.advance(2_000);
    expect(h.counter).toBe(2);
    h.poller.stop();
    expect(h.poller.isRunning()).toBe(false);
    expect(h.pendingCount()).toBe(0);
    h.setVisibility(true); // événement APRÈS stop : plus aucun effet
    h.advance(10_000);
    expect(h.counter).toBe(2);
  });

  it("stop pendant un passage en arrière-plan : le retour de visibilité ne réarme rien", () => {
    const h = createHarness(1_000, true);
    h.setVisibility(false);
    h.poller.stop();
    h.setVisibility(true);
    expect(h.counter).toBe(0);
  });
});

describe("useVisiblePolling (hook) — branchement DOM verrouillé structurellement", () => {
  const source = readFileSync(path.join(process.cwd(), HOOK), "utf8");

  it("expose le hook et la fabrique pure (testable en Node)", () => {
    expect(source).toContain("export function useVisiblePolling");
    expect(source).toContain("export function createVisibilityPoller");
  });

  it("ms = null désactive le sondage (retour anticipé avant tout abonnement)", () => {
    expect(source).toContain("if (ms === null || ms <= 0) return;");
  });

  it("gated sur document.visibilityState + visibilitychange", () => {
    expect(source).toContain('document.visibilityState === "visible"');
    expect(source).toContain('document.addEventListener("visibilitychange", handler)');
    expect(source).toContain('document.removeEventListener("visibilitychange", handler)');
  });

  it("horloge via window.setInterval / window.clearInterval avec cleanup strict", () => {
    expect(source).toContain("window.setInterval(handler, interval)");
    expect(source).toContain("window.clearInterval(timer");
    expect(source).toContain("return () => poller.stop();");
  });

  it("la callback est conservée par réf : l'identité du closure ne redémarre pas l'intervalle", () => {
    expect(source).toContain("fnRef.current = fn;");
    expect(source).toContain("fn: () => fnRef.current()");
  });
});
