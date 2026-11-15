import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/status (Task 126) — statut PUBLIC des services pour moniteurs
 * d'uptime : non authentifié, 200 + status "ok" quand tout va bien, 503 +
 * "degraded" dès qu'un service flanche (auth, r2, ticks), version = empreinte
 * de déploiement, cache CDN 30 s.
 */

const pingR2Mock = vi.fn();
const tickQueueConfiguredMock = vi.fn();

vi.mock("@/lib/storage/r2", () => ({
  pingR2: (...args: unknown[]) => pingR2Mock(...args),
}));

vi.mock("@/lib/queue/tick-queue", () => ({
  tickQueueConfigured: () => tickQueueConfiguredMock(),
}));

// Le BUILD_ID effectivement servi (.next/BUILD_ID) a la PRIORITÉ sur les
// replis historiques (durcissement 2026-10-22) : on le neutralise ici pour
// que ce test porte sur la chaîne de repli (GEN3IA_RELEASE /
// VERCEL_DEPLOYMENT_ID) indépendamment de la présence d'un build local —
// sinon le test ne passerait qu'avant tout `npm run build`.
vi.mock("@/lib/deploy/build-id", () => ({
  readBuildId: () => null,
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VERCEL_DEPLOYMENT_ID = "dpl-test-126";
  pingR2Mock.mockResolvedValue({ ok: true });
  tickQueueConfiguredMock.mockReturnValue(true);
});

describe("GET /api/status", () => {
  it("répond ok (200) avec version + services quand tout est sain", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("s-maxage=30");
    const body = (await response.json()) as { status: string; version: string; services: Record<string, { ok: boolean }> };
    expect(body.status).toBe("ok");
    expect(body.version).toBe("dpl-test-126");
    expect(body.services.auth.ok).toBe(true);
    expect(body.services.r2.ok).toBe(true);
    expect(body.services.ticks.ok).toBe(true);
  });

  it("répond degraded (503) quand R2 est en panne", async () => {
    pingR2Mock.mockResolvedValue({ ok: false, reason: "timeout" });
    const response = await GET();
    expect(response.status).toBe(503);
    const body = (await response.json()) as { status: string; services: { r2: { ok: boolean; reason: string }; ticks: { ok: boolean } } };
    expect(body.status).toBe("degraded");
    expect(body.services.r2.ok).toBe(false);
    // Les ticks vivent dans R2 : ils suivent la panne du stockage.
    expect(body.services.ticks.ok).toBe(false);
  });

  it("dégrade aussi quand la file de ticks n'est pas configurée", async () => {
    tickQueueConfiguredMock.mockReturnValue(false);
    const response = await GET();
    expect(response.status).toBe(503);
    const body = (await response.json()) as { services: { ticks: { ok: boolean; reason: string } } };
    expect(body.services.ticks.reason).toBe("not_configured");
  });

  it("auth suit la panne R2 : la connexion e-mail (comptes scrypt R2) devient indisponible", async () => {
    // Correctif Job 478451 : la sonde auth mesure la VRAIE voie de connexion
    // (comptes R2 + cookie signé), plus le compte de service Firebase Admin.
    pingR2Mock.mockResolvedValue({ ok: false, reason: "timeout" });
    const response = await GET();
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      services: { auth: { ok: boolean; reason: string }; r2: { ok: boolean } };
    };
    expect(body.services.auth.ok).toBe(false);
    expect(body.services.auth.reason).toBe("timeout");
    expect(body.services.r2.ok).toBe(false);
  });

  it("auth reste OK sans compte de service Firebase Admin (dépendance legacy hors flux utilisateur)", async () => {
    // Constat production 2026-10-28 : un VPS sans FIREBASE_PRIVATE_KEY
    // servait un faux « auth: degraded » alors que le login R2 répondait.
    // Le compte de service n'est requis par aucun flux utilisateur — son
    // absence ne dégrade plus le statut public.
    pingR2Mock.mockResolvedValue({ ok: true });
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { services: { auth: { ok: boolean } } };
    expect(body.services.auth.ok).toBe(true);
  });
});
