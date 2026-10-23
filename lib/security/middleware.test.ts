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
import {
  formaterTraceparent,
  parserTraceparent,
  w3cTraceIdDepuisGen3ia,
} from "@/lib/observability/trace-w3c";

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

  it("publicité utilisateur ouverte à tous : /settings/ads passe ; page admin reste 403", async () => {
    mockedGetPlatformRole.mockResolvedValue("user");
    // DEMANDE PROPRIÉTAIRE (restauration) : la page Publicité est ouverte
    // à TOUS LES COMPTES.
    const ads = await middleware(
      requestTo("/settings/ads", { cookie: sessionCookieFor("user-ads") }),
    );
    expect(isPassed(ads)).toBe(true);

    // (L'ancien contre-exemple /studio/console — IDE dev — a été supprimé
    // avec la surface studio ; la page admin reste le cas 403 de référence.)
    const adminPage = await middleware(
      requestTo("/admin", { cookie: sessionCookieFor("user-ads") }),
    );
    expect(adminPage.status).toBe(403);
  });

  it("surfaces supprimées workspace/studio : restreint pour un utilisateur standard (la redirection /dashboard est portée par next.config)", async () => {
    mockedGetPlatformRole.mockResolvedValue("user");
    const denied = await middleware(
      requestTo("/studio", { cookie: sessionCookieFor("user-studio") }),
    );
    expect(denied.status).toBe(403);

    const deniedWorkspace = await middleware(
      requestTo("/workspace/conversations", { cookie: sessionCookieFor("user-studio") }),
    );
    expect(deniedWorkspace.status).toBe(403);
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

describe("traceparent W3C (Task K — tracing distribué)", () => {
  const TRACE_ID_W3C = "4bf92f3577b34da6a3ce929d0e0e4736";
  const SPAN_ID_W3C = "00f067aa0ba902b7";

  function traceparentEmis(response: Response): ReturnType<typeof parserTraceparent> {
    return parserTraceparent(response.headers.get("traceparent"));
  }

  it("traceparent entrant valide → trace-id réutilisé comme x-gen3ia-trace-id", async () => {
    const response = await middleware(
      requestTo("/api/memory", { traceparent: `00-${TRACE_ID_W3C}-${SPAN_ID_W3C}-01` }),
    );
    expect(isPassed(response)).toBe(true);
    // Le trace-id W3C entrant devient la clé primaire Gen3ia (priorité 2).
    expect(response.headers.get("x-gen3ia-trace-id")).toBe(TRACE_ID_W3C);
    const emis = traceparentEmis(response);
    expect(emis).toBeDefined();
    expect(emis?.traceId).toBe(TRACE_ID_W3C);
    // Le span-id est NOUVEAU par requête (l'entrant n'est pas recopié).
    expect(emis?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(emis?.spanId).not.toBe(SPAN_ID_W3C);
  });

  it("les DEUX headers sont émis ensemble sur une réponse API (écho)", async () => {
    const response = await middleware(requestTo("/api/health"));
    expect(isPassed(response)).toBe(true);
    const traceId = response.headers.get("x-gen3ia-trace-id");
    expect(traceId).toMatch(/^trc_[0-9a-f-]{36}$/);
    const emis = traceparentEmis(response);
    expect(emis).toBeDefined();
    // Continuité : le traceparent émis porte la dérivation déterministe
    // du traceId Gen3ia retenu (bijection documentée docs/sre/tracing.md).
    expect(emis?.traceId).toBe(w3cTraceIdDepuisGen3ia(traceId!));
  });

  it("traceparent malformé → ignoré (génération Gen3ia, jamais réémis tel quel)", async () => {
    const response = await middleware(
      requestTo("/api/memory", { traceparent: "garbage-not-w3c" }),
    );
    expect(isPassed(response)).toBe(true);
    const traceId = response.headers.get("x-gen3ia-trace-id");
    expect(traceId).toMatch(/^trc_/);
    const emis = traceparentEmis(response);
    expect(emis?.traceId).toBe(w3cTraceIdDepuisGen3ia(traceId!));
  });

  it("trace-id W3C tous zéros (malformé) → ignoré", async () => {
    const response = await middleware(
      requestTo("/api/memory", { traceparent: `00-${"0".repeat(32)}-${SPAN_ID_W3C}-01` }),
    );
    expect(response.headers.get("x-gen3ia-trace-id")).toMatch(/^trc_/);
  });

  it("x-gen3ia-trace-id entrant est PRIORITAIRE sur le traceparent entrant", async () => {
    const response = await middleware(
      requestTo("/api/memory", {
        "x-gen3ia-trace-id": "client-trace-42",
        traceparent: `00-${TRACE_ID_W3C}-${SPAN_ID_W3C}-00`,
      }),
    );
    expect(isPassed(response)).toBe(true);
    expect(response.headers.get("x-gen3ia-trace-id")).toBe("client-trace-42");
    // Le traceparent émis dérive du custom retenu (PAS du trace-id entrant).
    expect(traceparentEmis(response)?.traceId).toBe(w3cTraceIdDepuisGen3ia("client-trace-42"));
    // Les flags entrants sont préservés (00 = non échantillonné côté amont).
    expect(traceparentEmis(response)?.flags).toBe("00");
  });

  it("nouveau span-id par requête (deux appels → deux sauts distincts)", async () => {
    const entrant = { traceparent: `00-${TRACE_ID_W3C}-${SPAN_ID_W3C}-01` };
    const premiere = traceparentEmis(await middleware(requestTo("/api/memory", entrant)));
    const seconde = traceparentEmis(await middleware(requestTo("/api/memory", entrant)));
    expect(premiere?.spanId).not.toBe(seconde?.spanId);
    expect(premiere?.traceId).toBe(seconde?.traceId); // même arbre W3C
  });

  it("403 API porte le COUPLE complet (x-gen3ia-trace-id + traceparent)", async () => {
    mockedGetPlatformRole.mockResolvedValue("user");
    const response = await middleware(
      requestTo("/api/admin/users", { cookie: sessionCookieFor("user-w3c-403") }),
    );
    expect(response.status).toBe(403);
    const traceId = response.headers.get("x-gen3ia-trace-id");
    expect(traceId).toMatch(/^trc_/);
    const emis = traceparentEmis(response);
    expect(emis?.traceId).toBe(w3cTraceIdDepuisGen3ia(traceId!));
    expect(emis?.flags).toBe("01");
  });

  it("coherence : le middleware émet le même format que le module partagé", () => {
    // Verrou structurel : l'émission du middleware (formaterTraceparent)
    // et la lecture des tests (parserTraceparent) partagent LE MÊME module.
    expect(formaterTraceparent(TRACE_ID_W3C, { spanId: SPAN_ID_W3C, flags: "01" })).toBe(
      `00-${TRACE_ID_W3C}-${SPAN_ID_W3C}-01`,
    );
  });
});
