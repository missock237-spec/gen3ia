import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

// requireUser est simule : le garde de route est teste de facon isolee
// (auth OK / auth KO), puis le comportement du rate limiting intégré.
vi.mock("./authenticated-request", () => ({
  requireUser: vi.fn(),
}));

// Annuaire du rôle admin simulé (demande n°7 — liste blanche).
vi.mock("@/lib/access/platform", () => ({
  getPlatformRole: vi.fn(),
}));

import { getPlatformRole } from "@/lib/access/platform";

import { requireUser } from "./authenticated-request";
import { protectRoute } from "./route-guard";

const mockedRequireUser = vi.mocked(requireUser);
const mockedGetPlatformRole = vi.mocked(getPlatformRole);

function requestTo(pathname = "/api/test"): NextRequest {
  return new NextRequest(`https://gen3ia.local${pathname}`, { method: "GET" });
}

beforeEach(() => {
  // resetAllMocks (et non clearAllMocks) : supprime AUSSI les
  // implémentations résiduelles (mockResolvedValue("admin") d'un test
  // précédent fuyait dans les suivants — l'annuaire simulé répondait
  // « admin » à des uids jamais configurés).
  vi.resetAllMocks();
});

describe("protectRoute — securite d'acces", () => {
  it("refuse avec 401 une requete non authentifiee", async () => {
    mockedRequireUser.mockRejectedValue(new Error("Unauthorized"));
    const result = await protectRoute(requestTo());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.success).toBe(false);
    }
  });

  it("expose le contexte utilisateur authentifie (uid, email, claims)", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "user-1", email: "user@test.io", claims: { admin: false } });
    // /api/memory : famille « mémoire permanente » (liste blanche n°7).
    const result = await protectRoute(requestTo("/api/memory"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.userId).toBe("user-1");
      expect(result.context.email).toBe("user@test.io");
      expect(result.context.claims).toEqual({ admin: false });
    }
    // Chemin allowlisté : l'annuaire de rôle n'est JAMAIS consulté.
    expect(mockedGetPlatformRole).not.toHaveBeenCalled();
  });
});

describe("protectRoute — liste blanche utilisateur (demande n°7, barrière n°2)", () => {
  it("refuse avec 403 un utilisateur standard sur un chemin restreint", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "user-std-1", claims: { admin: false } });
    const result = await protectRoute(requestTo("/api/admin/users"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.success).toBe(false);
      expect(result.response.headers.get("x-gen3ia-trace-id")).toBeTruthy();
    }
  });

  it("refuse un utilisateur sans claims admin définis (cookie de session)", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "user-cookie-1", claims: { provider: "password", source: "session-cookie" } });
    mockedGetPlatformRole.mockResolvedValue("user");
    const result = await protectRoute(requestTo("/api/agents/run"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("laisse passer un admin par custom claim (Bearer)", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "admin-claim-1", claims: { admin: true } });
    const result = await protectRoute(requestTo("/api/admin/users"));
    expect(result.ok).toBe(true);
    expect(mockedGetPlatformRole).not.toHaveBeenCalled();
  });

  it("laisse passer un admin résolu par le rôle plateforme (annuaire)", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "admin-role-1", claims: { source: "session-cookie" } });
    mockedGetPlatformRole.mockResolvedValue("admin");
    const result = await protectRoute(requestTo("/api/developer/terminal"));
    expect(result.ok).toBe(true);
    expect(mockedGetPlatformRole).toHaveBeenCalledWith("admin-role-1");
  });

  it("échec de l'annuaire → fail-closed (403), sans mettre l'erreur en cache", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "user-outage-guard", claims: {} });
    mockedGetPlatformRole.mockRejectedValueOnce(new Error("annuaire indisponible"));

    const first = await protectRoute(requestTo("/api/orchestrator"));
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.response.status).toBe(403);

    // L'erreur n'est pas cachée : l'appel suivant reconsulte l'annuaire.
    mockedGetPlatformRole.mockResolvedValueOnce("user");
    const second = await protectRoute(requestTo("/api/orchestrator"));
    expect(second.ok).toBe(false);
    expect(mockedGetPlatformRole).toHaveBeenCalledTimes(2);
  });

  it("un refus 403 ne consomme PAS le quota de débit", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "user-denied-quota", claims: { admin: false } });
    const options = { key: "route-refusee", rateLimit: { limit: 1, windowMs: 60_000 } };

    for (let i = 0; i < 5; i++) {
      // Chemin RESTREINT (demande n°7) — /api/ads/generate est désormais
      // ouvert à tous les comptes (publicité utilisateur, demande
      // propriétaire), il ne peut plus servir de refus d'exemple.
      const result = await protectRoute(requestTo("/api/orchestrator"), options);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(403); // jamais 429
    }
  });
});

describe("protectRoute — limitation de debit integree", () => {
  it("retourne 429 avec retry-after au-dela de la limite par utilisateur et par route", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "user-2" });
    const options = { key: "route-limitee", rateLimit: { limit: 2, windowMs: 60_000 } };

    const first = await protectRoute(requestTo("/api/memory"), options);
    const second = await protectRoute(requestTo("/api/memory"), options);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const third = await protectRoute(requestTo("/api/memory"), options);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.response.status).toBe(429);
      expect(third.response.headers.get("retry-after")).toBeTruthy();
      const body = await third.response.json();
      expect(body.error).toMatch(/trop de requetes/i);
    }
  });

  it("isole les compteurs entre utilisateurs et entre routes", async () => {
    const options = { key: "route-isolee", rateLimit: { limit: 1, windowMs: 60_000 } };
    mockedRequireUser.mockResolvedValueOnce({ uid: "user-a" });
    mockedRequireUser.mockResolvedValueOnce({ uid: "user-b" });
    mockedRequireUser.mockResolvedValueOnce({ uid: "user-a" });

    expect((await protectRoute(requestTo("/api/memory"), options)).ok).toBe(true);
    expect((await protectRoute(requestTo("/api/memory"), options)).ok).toBe(true);
    const sameUserSameRoute = await protectRoute(requestTo("/api/memory"), options);
    expect(sameUserSameRoute.ok).toBe(false);

    // Cle par defaut (= chemin) : une autre route possede son propre compteur.
    mockedRequireUser.mockResolvedValueOnce({ uid: "user-a" });
    const otherRoute = await protectRoute(requestTo("/api/knowledge"), { rateLimit: { limit: 1, windowMs: 60_000 } });
    expect(otherRoute.ok).toBe(true);
  });
});
