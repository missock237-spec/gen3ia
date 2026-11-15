import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Task 151 — POST /api/auth/r2/signup.
 *
 * Inscription par compte natif R2 : compte créé dans R2 (hash scrypt),
 * identité + wallet provisionnés, espace de stockage ouvert (fichier de
 * bienvenue), session posée par cookie signé `gen3ia_session`
 * (provider « r2-password »). Pannes de provisionnement → degraded:true,
 * session quand même.
 */

const r2State = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
}));

function snapshotOf(path: string) {
  const doc = r2State.docs.get(path);
  return {
    id: path.split("/").pop() ?? "",
    exists: doc !== undefined,
    data: () => (doc === undefined ? undefined : { ...doc }),
    get: (field: string) => (doc === undefined ? undefined : doc[field]),
  };
}

function refOf(path: string) {
  return {
    __path: path,
    id: path.split("/").pop() ?? "",
    get: async () => snapshotOf(path),
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      const current = opts?.merge ? r2State.docs.get(path) ?? {} : {};
      r2State.docs.set(path, { ...current, ...data });
    },
    update: async (patch: Record<string, unknown>) => {
      r2State.docs.set(path, { ...(r2State.docs.get(path) ?? {}), ...patch });
    },
    delete: async () => {
      r2State.docs.delete(path);
    },
  };
}

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => ({ doc: (id: string) => refOf(`${name}/${id}`) }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const pending: Array<{ ref: ReturnType<typeof refOf>; op: string; data?: Record<string, unknown> }> = [];
      const tx = {
        get: async (ref: ReturnType<typeof refOf>) => snapshotOf(ref.__path),
        set: (ref: ReturnType<typeof refOf>, data: Record<string, unknown>) => {
          pending.push({ ref, op: "set", data });
        },
        update: (ref: ReturnType<typeof refOf>, data: Record<string, unknown>) => {
          pending.push({ ref, op: "update", data });
        },
        delete: (ref: ReturnType<typeof refOf>) => {
          pending.push({ ref, op: "delete" });
        },
      };
      const result = await fn(tx);
      for (const operation of pending) {
        if (operation.op === "set" && operation.data) await operation.ref.set(operation.data);
        else if (operation.op === "update" && operation.data) await operation.ref.update(operation.data);
        else if (operation.op === "delete") await operation.ref.delete();
      }
      return result;
    },
  },
}));

vi.mock("@/lib/r2fs", () => ({
  FieldValue: {
    serverTimestamp: () => ({ __sentinel: "serverTimestamp" }),
    increment: (n: number) => ({ __sentinel: "increment", n }),
  },
  Timestamp: { fromMillis: (ms: number) => ({ __ms: ms, toMillis: () => ms }) },
}));

vi.mock("@/lib/security/rate-limit", () => ({
  clientIp: vi.fn(() => "203.0.113.10"),
  enforceRateLimit: vi.fn(async () => ({ allowed: true, remaining: 9, retryAfterMs: 0 })),
}));

const ensureIdentityMock = vi.fn(async (params: { uid: string }) => ({ uid: params.uid }));
vi.mock("@/lib/identity/service", () => ({
  ensureIdentity: (...args: unknown[]) => ensureIdentityMock(...(args as [Parameters<typeof ensureIdentityMock>[0]])),
}));

vi.mock("@/lib/billing/wallet", () => ({
  getWallet: vi.fn(async () => ({
    currency: "EUR",
    balanceMinor: 500,
    availableMinor: 500,
    reservedMinor: 0,
    welcomeGranted: true,
  })),
}));

const storePermanentFileMock = vi.fn(async (params: { userId: string; filename: string }) => ({
  path: `users/${params.userId}/permanent/bienvenue`,
  filename: params.filename,
  sizeBytes: 512,
  contentType: "text/plain",
}));
vi.mock("@/lib/storage/permanent-user-storage", () => ({
  storePermanentFile: (...args: unknown[]) =>
    storePermanentFileMock(...(args as [Parameters<typeof storePermanentFileMock>[0]])),
}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

import { POST } from "./route";
import { verifySessionCookie } from "@/lib/server/session-cookie";

function requeteInscription(corps: Record<string, unknown>): NextRequest {
  return new NextRequest("https://gen3ia.local/api/auth/r2/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corps),
  });
}

const INSCRIPTION_VALIDE = {
  email: "Nouvel.Utilisateur@Exemple.fr",
  password: "motdepasse-solide-2026",
  firstName: "Nouvel",
  lastName: "Utilisateur",
  username: "nouvel.util",
  country: "Cameroun",
  language: "fr",
  timezone: "Africa/Douala",
};

beforeEach(() => {
  r2State.docs.clear();
  vi.clearAllMocks();
});

describe("POST /api/auth/r2/signup — inscription compte R2", () => {
  it("inscription valide : compte R2 + identité + wallet + espace + session", async () => {
    const response = await POST(requeteInscription(INSCRIPTION_VALIDE));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(body.degraded).toBeUndefined();
    expect(body.wallet).toMatchObject({ currency: "EUR", welcomeGranted: true });

    const user = body.user as Record<string, unknown>;
    expect(String(user.uid)).toMatch(/^r2_[a-f0-9]{24}$/);
    expect(user.email).toBe("nouvel.utilisateur@exemple.fr");
    expect(user.name).toBe("Nouvel Utilisateur");

    // Compte + index e-mail créés dans R2.
    expect([...r2State.docs.keys()].filter((p) => p.startsWith("authAccounts/"))).toHaveLength(1);
    expect([...r2State.docs.keys()].filter((p) => p.startsWith("authEmailIndex/"))).toHaveLength(1);
    const compte = [...r2State.docs.values()].find((d) => d.passwordHash !== undefined);
    expect(String(compte?.passwordHash)).toMatch(/^scrypt\$/);
    expect(String(compte?.provider)).toBe("r2-password");

    // Identité provisionnée avec le provider natif.
    expect(ensureIdentityMock).toHaveBeenCalledTimes(1);
    expect(ensureIdentityMock.mock.calls[0]?.[0]).toMatchObject({
      email: "nouvel.utilisateur@exemple.fr",
      username: "nouvel.util",
      country: "Cameroun",
    });

    // Espace de stockage ouvert : fichier de bienvenue déposé.
    expect(storePermanentFileMock).toHaveBeenCalledTimes(1);
    expect(storePermanentFileMock.mock.calls[0]?.[0]).toMatchObject({
      userId: user.uid,
      filename: "Bienvenue dans votre espace Gen3ia.txt",
    });

    // Session posée : cookie signé vérifiable (provider r2-password).
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("gen3ia_session=");
    expect(setCookie).toContain("HttpOnly");
    const valeur = /gen3ia_session=([^;]+)/.exec(setCookie)?.[1];
    const session = verifySessionCookie(valeur);
    expect(session?.uid).toBe(user.uid);
    expect(session?.email).toBe("nouvel.utilisateur@exemple.fr");
    expect(session?.provider).toBe("r2-password");
  });

  it("e-mail déjà utilisé → 409 + message, aucun second compte", async () => {
    await POST(requeteInscription(INSCRIPTION_VALIDE));
    const response = await POST(requeteInscription({ ...INSCRIPTION_VALIDE, username: "autre.nom" }));
    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(String(body.error)).toContain("déjà utilisée");
    expect([...r2State.docs.keys()].filter((p) => p.startsWith("authAccounts/"))).toHaveLength(1);
  });

  it("mot de passe trop court → 400", async () => {
    const response = await POST(
      requeteInscription({ ...INSCRIPTION_VALIDE, password: "court" }),
    );
    expect(response.status).toBe(400);
  });

  it("corps invalide (nom d'utilisateur) → 400 sans création", async () => {
    const response = await POST(
      requeteInscription({ ...INSCRIPTION_VALIDE, username: "x" }),
    );
    expect(response.status).toBe(400);
    expect(r2State.docs.size).toBe(0);
  });

  it("panne du provisionnement → degraded:true MAIS session posée", async () => {
    ensureIdentityMock.mockRejectedValueOnce(new Error("R2 indisponible"));
    const response = await POST(requeteInscription(INSCRIPTION_VALIDE));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(body.degraded).toBe(true);
    expect(response.headers.get("set-cookie")).toContain("gen3ia_session=");
  });

  it("limite de débit atteinte → 429 sans création", async () => {
    const { enforceRateLimit } = await import("@/lib/security/rate-limit");
    vi.mocked(enforceRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      retryAfterMs: 60_000,
    } as never);
    const response = await POST(requeteInscription(INSCRIPTION_VALIDE));
    expect(response.status).toBe(429);
    expect(r2State.docs.size).toBe(0);
  });
});
