import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * RAPPORT D'ÉVALUATION (/api/ia/auto-apprentissage/rapport) :
 *  - expose l'historique COMPLET des évaluations persistées par domaine
 *    (et pas seulement la dernière, comme le GET principal) ;
 *  - résume par domaine (dernière/meilleure précision, tendance, validité) ;
 *  - refuse poliment (429) sous quota, 401 sans session.
 * Aucune métrique fabriquée : tout vient de lireEtatAuto (mocké ici).
 */

vi.mock("@/lib/security/authenticated-request", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/cache/redis", () => ({
  rateLimitDistributed: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }),
}));
vi.mock("@/lib/entrainement-auto/etat", () => ({ lireEtatAuto: vi.fn() }));

import { requireUser } from "@/lib/security/authenticated-request";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { lireEtatAuto } from "@/lib/entrainement-auto/etat";

import { GET } from "./route";

const mockUser = vi.mocked(requireUser);
const mockLimit = vi.mocked(rateLimitDistributed);
const mockEtat = vi.mocked(lireEtatAuto);

const ETAT = {
  version: 3,
  demarreA: "2026-01-01T00:00:00.000Z",
  cycles: 12,
  maitrise: {
    catalogueVersion: 1,
    atteinteA: null,
    evaluationsTotales: 9,
    cyclesSansProgres: 0,
    domaines: {
      conversation: {
        datasetsIngerees: ["hf/x"],
        pairesIngestees: 400,
        echantillonsIngestes: 0,
        passesConsicutifs: 2,
        maitriseA: "2026-02-01T00:00:00.000Z",
        dernieresEvaluations: [
          { dateA: "2026-02-01T00:00:00.000Z", accuracy: 0.9, unites: 40, valide: true },
          { dateA: "2026-01-31T00:00:00.000Z", accuracy: 0.82, unites: 30, valide: true },
          { dateA: "2026-01-30T00:00:00.000Z", accuracy: 0.5, unites: 5, valide: false },
        ],
      },
    },
  },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockUser.mockResolvedValue({ uid: "u1", claims: {} } as Awaited<ReturnType<typeof requireUser>>);
  mockEtat.mockResolvedValue(ETAT);
});

function request() {
  return new NextRequest("http://localhost/api/ia/auto-apprentissage/rapport", { method: "GET" });
}

describe("GET /api/ia/auto-apprentissage/rapport", () => {
  it("liste l'historique complet et résume par domaine", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rapport.evaluationsTotales).toBe(9);
    expect(body.rapport.maitriseComplete).toBe(false);
    expect(body.rapport.domainesMaitrises).toBe(1);
    const conversation = body.domaines.find((d: { id: string }) => d.id === "conversation");
    expect(conversation.evaluations).toHaveLength(3);
    expect(conversation.resume.derniereAccuracy).toBe(0.9);
    expect(conversation.resume.evaluationsValides).toBe(2);
    expect(conversation.resume.meilleureAccuracy).toBe(0.9);
    // Tendance = dernière − plus ancienne consignée (0.9 − 0.5 = 0.4).
    expect(conversation.resume.tendance).toBeCloseTo(0.4, 2);
    // Honnêteté : l'évaluation NON valide reste listée (signalée, pas masquée).
    expect(conversation.evaluations.some((e: { valide: boolean }) => !e.valide)).toBe(true);
  });

  it("renvoie 429 sous quota", async () => {
    mockLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 30_000 } as never);
    const response = await GET(request());
    expect(response.status).toBe(429);
  });

  it("renvoie 401 sans session", async () => {
    const { HttpError } = await import("@/lib/security/http-errors");
    mockUser.mockRejectedValueOnce(new HttpError(401, "Authentification requise.", "AUTH_REQUIRED"));
    const response = await GET(request());
    expect(response.status).toBe(401);
  });
});
