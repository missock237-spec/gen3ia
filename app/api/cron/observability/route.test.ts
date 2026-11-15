import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Sentinelle d'observabilité (durcissement production) — POST
 * /api/cron/observability : auth tick obligatoire (401 sinon), composition de
 * métriques 100 % réelles (HTTP 5xx, latence proxy, heap, self-review,
 * concurrence) et déclenchement du moteur d'alertes.
 */

const verifyTickRequestMock = vi.fn();
const checkAndAlertMock = vi.fn();

vi.mock("@/lib/queue/tick-queue", () => ({
  verifyTickRequest: (...args: unknown[]) => verifyTickRequestMock(...args),
}));

vi.mock("@/lib/observability/alerts", () => ({
  checkAndAlert: (...args: unknown[]) => checkAndAlertMock(...args),
}));

vi.mock("@/lib/observability/logger", () => ({
  executionLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@/lib/observability/metrics", () => ({
  getSystemHealth: () => ({
    status: "healthy",
    uptimeSec: 120,
    memory: { rssMb: 300, heapUsedMb: 180, heapTotalMb: 360 },
    checkedAt: new Date().toISOString(),
  }),
}));

vi.mock("@/lib/observability/metrics-registry", () => ({
  instantane: () => ({
    compteurs: [
      { route: "chat", statut: "2xx", total: 90 },
      { route: "chat", statut: "5xx", total: 10 },
      { route: "pages", statut: "2xx", total: 100 },
    ],
    durees: [{ route: "chat", moyenneMs: 1200, echantillons: 100 }],
    uptimeSecondes: 120,
    memoireRssOctets: 314_572_800,
    memoireTasUtiliseOctets: 188_743_680,
  }),
}));

vi.mock("@/lib/observability/self-review-metrics", () => ({
  instantaneSelfReview: () => ({
    conforme: 6,
    ameliore: 2,
    error: 2,
    skips: { disabled: 0, too_short: 40, too_long: 0, error: 0 },
    creeLe: Date.now(),
  }),
}));

vi.mock("@/lib/security/concurrency", () => ({
  instantaneConcurrence: () => ({
    actifs: 3,
    maximum: 16,
    totalAcquis: 500,
    totalRefuses: 0,
    refusesParRoute: [],
  }),
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  verifyTickRequestMock.mockReturnValue(true);
  checkAndAlertMock.mockResolvedValue([]);
});

describe("POST /api/cron/observability", () => {
  it("refuse sans signature/tick valide (401 fail-closed)", async () => {
    verifyTickRequestMock.mockReturnValue(false);
    const response = await POST(new Request("http://local/api/cron/observability", { method: "POST" }));
    expect(response.status).toBe(401);
    expect(checkAndAlertMock).not.toHaveBeenCalled();
  });

  it("évalue des métriques RÉELLES et délègue au moteur d'alertes", async () => {
    const response = await POST(
      new Request("http://local/api/cron/observability", {
        method: "POST",
        headers: { authorization: "Bearer secret-cron" },
        body: JSON.stringify({ source: "test" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      evaluated: { errorRate: number; p95ProxyMs: number; heapUsedRatio: number; selfReviewErrorRatio: number; concurrencySaturated: boolean };
      alerts: string[];
    };
    // 5xx = 10 / 200 requêtes → 0.05 (le seuil d'alerte « High Error Rate »)
    expect(body.evaluated.errorRate).toBeCloseTo(0.05, 5);
    // Proxy P95 = moyenne glissante la plus défavorable (chat 1200 ms)
    expect(body.evaluated.p95ProxyMs).toBe(1200);
    // heap 180/360 = 0.5
    expect(body.evaluated.heapUsedRatio).toBeCloseTo(0.5, 5);
    // Self-review : 2 erreurs / 10 passes effectives = 0.2
    expect(body.evaluated.selfReviewErrorRatio).toBeCloseTo(0.2, 5);
    // Aucun refus de concurrence observé → pas de saturation
    expect(body.evaluated.concurrencySaturated).toBe(false);
    // Les métriques composées SONT celles passées au moteur d'alertes
    const metrics = checkAndAlertMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(metrics.errorRate).toBeCloseTo(0.05, 5);
    expect(metrics.selfReviewErrorRatio).toBeCloseTo(0.2, 5);
    expect(metrics.concurrencySaturated).toBe(false);
  });

  it("retourne les alertes déclenchées par le moteur", async () => {
    checkAndAlertMock.mockResolvedValue(["High Error Rate"]);
    const response = await POST(
      new Request("http://local/api/cron/observability", { method: "POST", body: "{}" }),
    );
    const body = (await response.json()) as { alerts: string[] };
    expect(body.alerts).toEqual(["High Error Rate"]);
  });
});
