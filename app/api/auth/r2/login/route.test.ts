import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Task 151 — POST /api/auth/r2/login.
 *
 * Connexion par identifiants d'un compte natif R2 : vérification scrypt,
 * cookie de session signé (provider « r2-password »), provisionnement
 * non bloquant. Échecs : message unique (anti-énumération), 401.
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
  enforceRateLimit: vi.fn(async () => ({ allowed: true, remaining: 29, retryAfterMs: 0 })),
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

vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

import { POST } from "./route";
import { verifySessionCookie } from "@/lib/server/session-cookie";
import { createR2Account } from "@/lib/auth/r2-accounts";

const EMAIL = "utilisateur@exemple.fr";
const PASSWORD = "motdepasse-solide-2026";

function requeteConnexion(corps: Record<string, unknown>): NextRequest {
  return new NextRequest("https://gen3ia.local/api/auth/r2/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corps),
  });
}

beforeEach(async () => {
  r2State.docs.clear();
  vi.clearAllMocks();
  await createR2Account({
    email: EMAIL,
    password: PASSWORD,
    displayName: "Utilisateur Exemple",
    username: "utilisateur",
  });
});

describe("POST /api/auth/r2/login — connexion par identifiants R2", () => {
  it("identifiants corrects → session posée, utilisateur reconnu", async () => {
    const response = await POST(requeteConnexion({ email: EMAIL, password: PASSWORD }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(body.degraded).toBeUndefined();
    const user = body.user as Record<string, unknown>;
    expect(String(user.uid)).toMatch(/^r2_[a-f0-9]{24}$/);
    expect(user.email).toBe(EMAIL);
    expect(body.wallet).toMatchObject({ currency: "EUR" });

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("gen3ia_session=");
    const valeur = /gen3ia_session=([^;]+)/.exec(setCookie)?.[1];
    const session = verifySessionCookie(valeur);
    expect(session?.uid).toBe(user.uid);
    expect(session?.provider).toBe("r2-password");
    // L'identité est rafraîchie à chaque connexion (idempotent).
    expect(ensureIdentityMock).toHaveBeenCalledTimes(1);
  });

  it("mot de passe erroné → 401 + message unique, aucune session", async () => {
    const response = await POST(requeteConnexion({ email: EMAIL, password: "faux-mot-de-passe" }));
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(String(body.error)).toBe("E-mail ou mot de passe incorrect.");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("compte inconnu → même 401 que mot de passe erroné (anti-énumération)", async () => {
    const response = await POST(
      requeteConnexion({ email: "inconnu@exemple.fr", password: "nimporte-quoi" }),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(String(body.error)).toBe("E-mail ou mot de passe incorrect.");
  });

  it("panne du provisionnement → degraded:true mais session valide", async () => {
    ensureIdentityMock.mockRejectedValueOnce(new Error("identité indisponible"));
    const response = await POST(requeteConnexion({ email: EMAIL, password: PASSWORD }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect(body.degraded).toBe(true);
    expect(response.headers.get("set-cookie")).toContain("gen3ia_session=");
  });

  it("corps malformé → 400", async () => {
    const response = await POST(requeteConnexion({ email: "" }));
    expect(response.status).toBe(400);
  });
});
