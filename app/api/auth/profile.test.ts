import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

/**
 * Task 108-b — GET/PUT/POST /api/auth/profile sur la base d'identités R2.
 *
 * Cloisonnement propriétaire : le uid vient UNIQUEMENT du mécanisme
 * d'authentification (requireUser — Bearer Firebase ou cookie signé),
 * jamais du corps de requête — un utilisateur ne peut lire/modifier que
 * SON identité, par construction. PATCH strict : champ inconnu → 422 ;
 * champs immutables ignorés ; theme persisté (contrat lot 108-c).
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

vi.mock("@/lib/security/authenticated-request", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/firebase/auth-server", () => ({
  verifyFirebaseToken: vi.fn(),
}));

import { verifyFirebaseToken } from "@/lib/firebase/auth-server";
import { requireUser } from "@/lib/security/authenticated-request";
import { getIdentity } from "@/lib/identity/r2-identity-store";

import { GET, POST, PUT } from "./profile/route";

const UID = "uid-profile-1";

/** Document d'identité brut (forme stockée) — surchargeable par test. */
function documentIdentite(uid: string, surcharge: Record<string, unknown> = {}): string {
  const maintenant = new Date().toISOString();
  return JSON.stringify({
    uid,
    email: null,
    emailVerified: false,
    displayName: null,
    firstName: null,
    lastName: null,
    username: null,
    photoURL: null,
    phoneNumber: null,
    country: null,
    bio: null,
    language: "fr",
    timezone: "UTC",
    theme: "dark",
    providers: [],
    plan: "free",
    role: "user",
    status: "active",
    createdAt: maintenant,
    updatedAt: maintenant,
    lastLoginAt: maintenant,
    identityVersion: 1,
    ...surcharge,
  });
}

function semer(uid: string, surcharge: Record<string, unknown> = {}): void {
  r2State.store.set(`identities/${uid}.json`, Buffer.from(documentIdentite(uid, surcharge)));
}

function getRequest(): NextRequest {
  return new NextRequest("https://gen3ia.local/api/auth/profile", { method: "GET" });
}

function putRequest(corps: unknown): NextRequest {
  return new NextRequest("https://gen3ia.local/api/auth/profile", {
    method: "PUT",
    headers: { "content-type": "application/json", origin: "https://gen3ia.local" },
    body: JSON.stringify(corps),
  });
}

beforeEach(() => {
  r2State.store.clear();
  r2State.uploads.length = 0;
  r2State.failUpload = false;
  r2State.failDownload = false;
  vi.mocked(requireUser).mockResolvedValue({ uid: UID } as never);
  vi.mocked(verifyFirebaseToken).mockResolvedValue({
    uid: UID,
    sub: UID,
    email: "signup@example.com",
    email_verified: true,
    firebase: { sign_in_provider: "password", identities: {} },
  } as never);
});

describe("GET /api/auth/profile — identité complète", () => {
  it("profil non provisionné → 404 avec message FR", async () => {
    const response = await GET(getRequest());
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(String(body.error)).toMatch(/provisionn/i);
  });

  it("identité seedée → 200 avec l'identité COMPLÈTE de l'appelant", async () => {
    semer(UID, { email: "user@example.com", emailVerified: true, displayName: "Utilisateur Profil", theme: "light", providers: ["password"] });
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { identity: Record<string, unknown> };
    expect(body.identity.uid).toBe(UID);
    expect(body.identity.email).toBe("user@example.com");
    expect(body.identity.theme).toBe("light");
    expect(body.identity.plan).toBe("free");
    expect(body.identity.providers).toEqual(["password"]);
  });

  it("cloisonnement : l'identité servie est celle du uid du JETON (jamais d'autrui)", async () => {
    // Deux identités existent ; l'appelant authentifié est uid-profile-1.
    semer(UID, { email: `${UID}@example.com` });
    semer("uid-profile-2", { email: "autre@example.com" });
    const response = await GET(getRequest());
    const body = (await response.json()) as { identity: { uid: string; email: string } };
    expect(body.identity.uid).toBe(UID);
    expect(body.identity.email).toBe(`${UID}@example.com`);
  });
});

describe("PUT /api/auth/profile — patch utilisateur (contrat thème 108-c)", () => {
  it("patch displayName + theme persistés dans la base R2", async () => {
    semer(UID, { displayName: "Ancien Nom", theme: "dark" });
    const response = await PUT(putRequest({ displayName: "Nouveau Nom", theme: "light" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.theme).toBe("light");
    const identity = await getIdentity(UID);
    expect(identity?.displayName).toBe("Nouveau Nom");
    expect(identity?.theme).toBe("light");
  });

  it("champ inconnu → 422", async () => {
    semer(UID);
    const response = await PUT(putRequest({ champPirate: true }));
    expect(response.status).toBe(422);
  });

  it("email/role/plan/status immutables → 200 mais SANS effet", async () => {
    semer(UID, { email: "user@example.com" });
    const response = await PUT(
      putRequest({ email: "pirate@example.com", role: "admin", plan: "enterprise", status: "disabled" }),
    );
    expect(response.status).toBe(200);
    const identity = await getIdentity(UID);
    expect(identity?.email).toBe("user@example.com");
    expect(identity?.role).toBe("user");
    expect(identity?.plan).toBe("free");
    expect(identity?.status).toBe("active");
  });

  it("profil non provisionné → 404", async () => {
    const response = await PUT(putRequest({ displayName: "X" }));
    expect(response.status).toBe(404);
  });

  it("base R2 en panne → 503 (mode dégradé explicite)", async () => {
    r2State.failDownload = true;
    const response = await PUT(putRequest({ displayName: "X" }));
    expect(response.status).toBe(503);
  });
});

describe("POST /api/auth/profile — contrat d'inscription historique (préservé)", () => {
  it("inscription → identité créée dans R2, réponse { ok, userId } inchangée", async () => {
    const request = new NextRequest("https://gen3ia.local/api/auth/profile", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer jeton",
        origin: "https://gen3ia.local",
      },
      body: JSON.stringify({
        firstName: "Jean",
        lastName: "Mbarga",
        username: "Jean.M",
        country: "Cameroun",
        language: "fr",
        timezone: "Africa/Douala",
        photoURL: null,
      }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, userId: UID });

    const identity = await getIdentity(UID);
    expect(identity?.firstName).toBe("Jean");
    expect(identity?.lastName).toBe("Mbarga");
    expect(identity?.displayName).toBe("Jean Mbarga");
    expect(identity?.username).toBe("jean.m"); // normalisé minuscule
    expect(identity?.email).toBe("signup@example.com");
    expect(identity?.emailVerified).toBe(true);
    expect(identity?.timezone).toBe("Africa/Douala");
    expect(identity?.providers).toEqual(["password"]);
  });

  it("corps invalide → 400 « Profil invalide. » (contrat préservé)", async () => {
    const request = new NextRequest("https://gen3ia.local/api/auth/profile", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer jeton" },
      body: JSON.stringify({ firstName: "", lastName: "X", username: "!!!" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("Profil invalide.");
  });
});
