import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

/**
 * Task 108-b — POST/GET/DELETE /api/auth/session sur la base d'identités R2.
 *
 * Contrat préservé : jeton valide → session établie même si la base
 * d'identités est en panne (degraded:true, identique à la philosophie
 * historique). Champ additionnel : user.theme (publicIdentity, contrat
 * lot 108-c). Mocks : auth Firebase, rate-limit, wallet, cookie de session,
 * R2 en mémoire.
 */

const r2State = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
  uploads: [] as string[],
  failUpload: false,
  failDownload: false,
}));

vi.mock("@/lib/storage/r2", () => ({
  putObject: async (options: { key: string; body: Uint8Array | Buffer; contentType: string; contentLength?: number }) => {
    if (r2State.failUpload) throw new Error("R2 upload impossible (mock)");
    const body = Buffer.from(options.body);
    r2State.store.set(options.key, body);
    r2State.uploads.push(options.key);
  },
  downloadFromR2: async (key: string) => {
    if (r2State.failDownload) throw new Error("R2 lecture impossible (mock)");
    const body = r2State.store.get(key);
    if (!body) {
      const error = new Error("The specified key does not exist.");
      error.name = "NoSuchKey";
      throw error;
    }
    return body;
  },
  deleteFromR2: async (key: string) => {
    r2State.store.delete(key);
  },
  listObjectsUnderPrefix: async () => [],
}));

vi.mock("@/lib/firebase/auth-server", () => ({
  verifyFirebaseToken: vi.fn(),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  clientIp: vi.fn(() => "203.0.113.10"),
  enforceRateLimit: vi.fn(async () => ({ allowed: true, remaining: 29, retryAfterMs: 0 })),
}));

vi.mock("@/lib/billing/wallet", () => ({
  getWallet: vi.fn(async () => ({
    currency: "EUR",
    balanceMinor: 500,
    availableMinor: 500,
    reservedMinor: 0,
    welcomeGranted: false,
  })),
}));

vi.mock("@/lib/server/session-cookie", () => ({
  sessionCookieHeader: vi.fn(() => "gen3ia_session=signe; Path=/; HttpOnly"),
  clearSessionCookieHeader: vi.fn(() => "gen3ia_session=; Max-Age=0"),
  readSessionCookie: vi.fn(),
}));

vi.mock("@/lib/security/mfa", () => ({
  mfaStatusFromToken: vi.fn(() => ({ secondFactorUsed: false })),
}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

import { verifyFirebaseToken } from "@/lib/firebase/auth-server";
import { readSessionCookie } from "@/lib/server/session-cookie";
import { getIdentity } from "@/lib/identity/r2-identity-store";

import { DELETE, GET, POST } from "./session/route";

const UID = "uid-session-1";

function jetonValide() {
  return {
    uid: UID,
    sub: UID,
    email: "user@example.com",
    email_verified: true,
    name: "Utilisateur Session",
    picture: "https://cdn.example.com/avatar.png",
    firebase: { sign_in_provider: "password", identities: {} },
  };
}

function postRequest(): NextRequest {
  return new NextRequest("https://gen3ia.local/api/auth/session", { method: "POST" });
}

beforeEach(() => {
  r2State.store.clear();
  r2State.uploads.length = 0;
  r2State.failUpload = false;
  r2State.failDownload = false;
  vi.mocked(verifyFirebaseToken).mockResolvedValue(jetonValide() as never);
  vi.mocked(readSessionCookie).mockReturnValue(null);
});

describe("POST /api/auth/session — provisioning identité R2", () => {
  it("jeton valide + R2 OK → identity créée, pas de degraded, user.theme présent", async () => {
    const response = await POST(postRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(body.degraded).toBeUndefined();
    expect(body.wallet).not.toBeNull();
    expect((body.user as Record<string, unknown>).theme).toBe("dark");
    // La base R2 contient bien l'identité provisionnée.
    const identity = await getIdentity(UID);
    expect(identity?.email).toBe("user@example.com");
    // Jeton vérifié → emailVerified autorité serveur.
    expect(identity?.emailVerified).toBe(true);
    expect(identity?.providers).toEqual(["password"]);
    // Cookie de session signé posé.
    expect(response.headers.get("set-cookie")).toContain("gen3ia_session=");
  });

  it("R2 indisponible → degraded:true MAIS session établie + wallet OK", async () => {
    r2State.failUpload = true;
    r2State.failDownload = true;
    const response = await POST(postRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(body.degraded).toBe(true);
    expect(body.wallet).not.toBeNull();
    expect(response.headers.get("set-cookie")).toContain("gen3ia_session=");
    // Aucune identité n'a pu être écrite.
    expect(r2State.uploads).toHaveLength(0);
  });

  it("idempotent : deux sessions → un seul document, une seule écriture", async () => {
    await POST(postRequest());
    await POST(postRequest());
    expect(r2State.uploads).toHaveLength(1);
    expect(r2State.store.size).toBe(1);
  });

  it("jeton invalide → 401 (seul chemin vers 401)", async () => {
    vi.mocked(verifyFirebaseToken).mockRejectedValue(new Error("Invalid or revoked Firebase ID token."));
    const response = await POST(postRequest());
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(false);
  });
});

describe("GET /api/auth/session — version cookie", () => {
  it("cookie valide → provisionne l'identité depuis les données du cookie", async () => {
    vi.mocked(readSessionCookie).mockReturnValue({
      uid: UID,
      email: "cookie@example.com",
      name: "Utilisateur Cookie",
      picture: null,
      provider: "password",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const request = new NextRequest("https://gen3ia.local/api/auth/session", { method: "GET" });
    const response = await GET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(body.degraded).toBeUndefined();
    expect((body.user as Record<string, unknown>).theme).toBe("dark");
    const identity = await getIdentity(UID);
    expect(identity?.email).toBe("cookie@example.com");
  });

  it("sans cookie → 401", async () => {
    const request = new NextRequest("https://gen3ia.local/api/auth/session", { method: "GET" });
    const response = await GET(request);
    expect(response.status).toBe(401);
  });
});

describe("DELETE /api/auth/session — déconnexion", () => {
  it("204 + effacement du cookie", async () => {
    const response = await DELETE();
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("gen3ia_session=");
  });
});
