import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

// requireUser est simule : le garde de route est teste de facon isolee
// (auth OK / auth KO), puis le comportement du rate limiting intégré.
vi.mock("./authenticated-request", () => ({
  requireUser: vi.fn(),
}));

import { requireUser } from "./authenticated-request";
import { protectRoute } from "./route-guard";

const mockedRequireUser = vi.mocked(requireUser);

function requestTo(pathname = "/api/test"): NextRequest {
  return new NextRequest(`https://gen3ia.local${pathname}`, { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
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
    const result = await protectRoute(requestTo());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.userId).toBe("user-1");
      expect(result.context.email).toBe("user@test.io");
      expect(result.context.claims).toEqual({ admin: false });
    }
  });
});

describe("protectRoute — limitation de debit integree", () => {
  it("retourne 429 avec retry-after au-dela de la limite par utilisateur et par route", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "user-2" });
    const options = { key: "route-limitee", rateLimit: { limit: 2, windowMs: 60_000 } };

    const first = await protectRoute(requestTo("/api/autre"), options);
    const second = await protectRoute(requestTo("/api/autre"), options);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const third = await protectRoute(requestTo("/api/autre"), options);
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

    expect((await protectRoute(requestTo("/api/x"), options)).ok).toBe(true);
    expect((await protectRoute(requestTo("/api/x"), options)).ok).toBe(true);
    const sameUserSameRoute = await protectRoute(requestTo("/api/x"), options);
    expect(sameUserSameRoute.ok).toBe(false);

    // Cle par defaut (= chemin) : une autre route possede son propre compteur.
    mockedRequireUser.mockResolvedValueOnce({ uid: "user-a" });
    const otherRoute = await protectRoute(requestTo("/api/y"), { rateLimit: { limit: 1, windowMs: 60_000 } });
    expect(otherRoute.ok).toBe(true);
  });
});
