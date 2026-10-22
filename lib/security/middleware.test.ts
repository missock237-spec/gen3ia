import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

/**
 * Tests d'intégration du middleware — liste blanche d'accès utilisateur
 * (demande n°7). L'identité est simulée aux frontières réelles :
 *  - Bearer  : @/lib/firebase/auth-server (vérification RS256) simulée ;
 *  - session : VRAI cookie signé gen3ia_session (HMAC réel, session-cookie.ts) ;
 *  - rôle    : @/lib/access/platform (annuaire plateforme) simulé.
 * Les chemins public/allowlistés ne doivent déclencher AUCUN appel
 * d'identité (coût nul sur le trafic légitime).
 */

vi.mock("@/lib/firebase/auth-server", () => ({
  verifyFirebaseToken: vi.fn(),
}));

vi.mock("@/lib/access/platform", () => ({
  getPlatformRole: vi.fn(),
}));

import { getPlatformRole } from "@/lib/access/platform";
import { verifyFirebaseToken } from "@/lib/firebase/auth-server";
import { signSessionPayload } from "@/lib/server/session-cookie";

import { middleware } from "../../middleware";

const mockedVerify = vi.mocked(verifyFirebaseToken);
const mockedGetPlatformRole = vi.mocked(getPlatformRole);

function requestTo(
  pathname: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`https://gen3ia.local${pathname}`, { method: "GET", headers });
}

function sessionCookieFor(uid: string): string {
  return `gen3ia_session=${signSessionPayload({
    uid,
    email: `${uid}@test.io`,
    name: uid,
    picture: null,
    provider: "password",
  })}`;
}

/** Réponse « continuation » du middleware (NextResponse.next). */
function isPassed(response: Response): boolean {
  return response.status < 400 && response.headers.get("x-middleware-next") === "1";
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("liste blanche — chemins public/allowlistés : aucun travail d'identité", () => {
  it("anonyme sur API publique (/api/health) → passe", async () => {
    const response = await middleware(requestTo("/api/health"));
    expect(isPassed(response)).toBe(true);
    expect(mockedVerify).not.toHaveBeenCalled();
    expect(mockedGetPlatformRole).not.toHaveBeenCalled();
  });

  it("anonyme sur API allowlistée (/api/memory) → passe, identité non consultée", async () => {
    const response = await middleware(requestTo("/api/memory"));
    expect(isPassed(response)).toBe(true);
    expect(mockedVerify).not.toHaveBeenCalled();
    expect(mockedGetPlatformRole).not.toHaveBeenCalled();
  });

  it("utilisateur standard sur page allowlistée (/billing) → passe", async () => {
    const response = await middleware(
      requestTo("/billing", { cookie: sessionCookieFor("user-billing") }),
    );
    expect(isPassed(response)).toBe(true);
    expect(mockedGetPlatformRole).not.toHaveBeenCalled();
  });

  it("page publique (/faq) → passe, même authentifié", async () => {
    const response = await middleware(
      requestTo("/faq", { cookie: sessionCookieFor("user-faq") }),
    );
    expect(isPassed(response)).toBe(true);
    expect(mockedGetPlatformRole).not.toHaveBeenCalled();
  });
});

describe("liste blanche — utilisateur standard (cookie de session réel)", () => {
  it("API restreinte (/api/admin/users) → 403 JSON signé (trace-id)", async () => {
    mockedGetPlatformRole.mockResolvedValue("user");
    const response = await middleware(
      requestTo("/api/admin/users", { cookie: sessionCookieFor("user-admin-api") }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("x-gen3ia-trace-id")).toMatch(/^trc_/);
    const body = (await response.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(mockedGetPlatformRole).toHaveBeenCalledWith("user-admin-api");
  });

  it("API agents hors planifications (/api/agents/run) → 403", async () => {
    mockedGetPlatformRole.mockResolvedValue("user");
    const response = await middleware(
      requestTo("/api/agents/run", { cookie: sessionCookieFor("user-agents") }),
    );
    expect(response.status).toBe(403);
  });

  it("API planifications (/api/agents/schedules) → passe (famille autorisée)", async () => {
    const response = await middleware(
      requestTo("/api/agents/schedules", { cookie: sessionCookieFor("user-schedules") }),
    );
    expect(isPassed(response)).toBe(true);
    expect(mockedGetPlatformRole).not.toHaveBeenCalled();
  });

  it("page restreinte (/admin) → 403 HTML", async () => {
    mockedGetPlatformRole.mockResolvedValue("user");
    const response = await middleware(
      requestTo("/admin", { cookie: sessionCookieFor("user-admin-page") }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-gen3ia-trace-id")).toBeNull();
    expect(await response.text()).toContain("403");
  });

  it("publicité utilisateur ouverte à tous : /settings/ads passe ; l'IDE dev /studio/console reste 403", async () => {
    mockedGetPlatformRole.mockResolvedValue("user");
    // DEMANDE PROPRIÉTAIRE (restauration) : la page Publicité est ouverte
    // à TOUS LES COMPTES.
    const ads = await middleware(
      requestTo("/settings/ads", { cookie: sessionCookieFor("user-ads") }),
    );
    expect(isPassed(ads)).toBe(true);

    const consoleDev = await middleware(
      requestTo("/studio/console", { cookie: sessionCookieFor("user-ads") }),
    );
    expect(consoleDev.status).toBe(403);
  });

  it("studio réouvert : /studio/create passe, /studio/console (IDE dev) → 403, /studio/connections passe", async () => {
    mockedGetPlatformRole.mockResolvedValue("user");
    const allowed = await middleware(
      requestTo("/studio/create", { cookie: sessionCookieFor("user-studio") }),
    );
    expect(isPassed(allowed)).toBe(true);

    const denied = await middleware(
      requestTo("/studio/console", { cookie: sessionCookieFor("user-studio") }),
    );
    expect(denied.status).toBe(403);

    const connections = await middleware(
      requestTo("/studio/connections", { cookie: sessionCookieFor("user-studio") }),
    );
    expect(isPassed(connections)).toBe(true);
  });

  it("page agent live (/live) → passe pour un utilisateur standard (réouverture PC + Android)", async () => {
    mockedGetPlatformRole.mockResolvedValue("user");
    const allowed = await middleware(
      requestTo("/live", { cookie: sessionCookieFor("user-live") }),
    );
    expect(isPassed(allowed)).toBe(true);
  });
});

describe("liste blanche — administrateurs (accès complet)", () => {
  it("admin par custom claim Bearer (vérifié) → passe sans consulter l'annuaire", async () => {
    mockedVerify.mockResolvedValue({
      uid: "admin-claim",
      sub: "admin-claim",
      admin: true,
      firebase: { identities: {}, sign_in_provider: "password" },
    } as never);
    const response = await middleware(
      requestTo("/api/admin/users", { authorization: "Bearer fake-but-mocked" }),
    );
    expect(isPassed(response)).toBe(true);
    expect(mockedGetPlatformRole).not.toHaveBeenCalled();
  });

  it("admin par rôle plateforme (session cookie) → passe", async () => {
    mockedGetPlatformRole.mockResolvedValue("admin");
    const response = await middleware(
      requestTo("/admin", { cookie: sessionCookieFor("admin-role") }),
    );
    expect(isPassed(response)).toBe(true);
  });

  it("admin par rôle plateforme (Bearer sans claim) → passe", async () => {
    mockedVerify.mockResolvedValue({
      uid: "admin-via-role",
      sub: "admin-via-role",
      firebase: { identities: {}, sign_in_provider: "password" },
    } as never);
    mockedGetPlatformRole.mockResolvedValue("admin");
    const response = await middleware(
      requestTo("/api/developer/api-keys", { authorization: "Bearer fake-but-mocked" }),
    );
    expect(isPassed(response)).toBe(true);
  });
});

describe("liste blanche — anonyme : comportement existant inchangé", () => {
  it("API restreinte anonyme → PASSE (la route lèvera son 401)", async () => {
    const response = await middleware(requestTo("/api/admin/users"));
    expect(isPassed(response)).toBe(true);
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it("page restreinte anonyme (/admin) → PASSE (redirection gérée par la page)", async () => {
    const response = await middleware(requestTo("/admin"));
    expect(isPassed(response)).toBe(true);
  });

  it("Bearer invalide + pas de session → traité anonyme (passe, route fera 401)", async () => {
    mockedVerify.mockRejectedValue(new Error("Invalid or revoked Firebase ID token."));
    const response = await middleware(
      requestTo("/api/notifications", { authorization: "Bearer garbage" }),
    );
    expect(isPassed(response)).toBe(true);
  });
});

describe("liste blanche — replis d'identité (sémantique requireUser)", () => {
  it("Bearer invalide + session valide standard → 403 (identifié par session)", async () => {
    mockedVerify.mockRejectedValue(new Error("Invalid or revoked Firebase ID token."));
    mockedGetPlatformRole.mockResolvedValue("user");
    const response = await middleware(
      requestTo("/api/tools/execute", {
        authorization: "Bearer garbage",
        cookie: sessionCookieFor("user-fallback"),
      }),
    );
    expect(response.status).toBe(403);
  });

  it("Bearer standard + annuaire en panne → fail-closed (403, non mis en cache)", async () => {
    mockedVerify.mockResolvedValue({
      uid: "user-outage",
      sub: "user-outage",
      firebase: { identities: {}, sign_in_provider: "password" },
    } as never);
    mockedGetPlatformRole.mockRejectedValue(new Error("annuaire indisponible"));
    const response = await middleware(
      requestTo("/api/orchestrator", { authorization: "Bearer fake-but-mocked" }),
    );
    expect(response.status).toBe(403);
  });
});

describe("en-têtes de sécurité préservés sur les réponses 403", () => {
  it("CSP, nosniff et X-Frame-Options posés sur un 403", async () => {
    mockedGetPlatformRole.mockResolvedValue("user");
    const response = await middleware(
      requestTo("/api/orchestrator", { cookie: sessionCookieFor("user-headers") }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("comportements préexistants du middleware (non-régression)", () => {
  it("isolation portail client : prioritaire, même pour un admin", async () => {
    mockedGetPlatformRole.mockResolvedValue("admin");
    const response = await middleware(
      requestTo("/admin", {
        cookie: `gen3ia_client_access=/client/c/demo; ${sessionCookieFor("admin-client")}`,
      }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://gen3ia.local/client/c/demo");
  });

  it("trace-id entrant sain réutilisé sur une réponse allowlistée", async () => {
    const response = await middleware(
      requestTo("/api/memory", { "x-gen3ia-trace-id": "client-trace-42" }),
    );
    expect(response.headers.get("x-gen3ia-trace-id")).toBe("client-trace-42");
  });

  it("CSP artefact sur /preview (public) inchangée", async () => {
    const response = await middleware(requestTo("/preview/abc"));
    expect(response.headers.get("content-security-policy")).toContain("'unsafe-eval'");
  });

  it("corrélation : 403 API porte un trace-id généré", async () => {
    mockedGetPlatformRole.mockResolvedValue("user");
    const response = await middleware(
      requestTo("/api/skills", { cookie: sessionCookieFor("user-trace") }),
    );
    expect(response.headers.get("x-gen3ia-trace-id")).toMatch(/^trc_[0-9a-f-]{36}$/);
  });
});
