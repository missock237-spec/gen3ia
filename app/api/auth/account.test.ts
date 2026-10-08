import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

/**
 * Task 108-b — DELETE /api/auth/account : la cascade RGPD supprime AUSSI
 * l'identité dans la base R2. INVARIANT : une panne R2 n'empêche JAMAIS la
 * suppression Auth/Firestore (l'utilisateur prime — on journalise et on
 * continue). Mocks : requireUser, Admin SDK Firestore (en mémoire), Admin
 * SDK Auth, audit sécurité, R2 en mémoire.
 */

const r2State = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
  uploads: [] as string[],
  failDelete: false,
}));

vi.mock("@/lib/storage/r2", () => ({
  putObject: async (options: { key: string; body: Uint8Array | Buffer; contentType: string; contentLength?: number }) => {
    const body = Buffer.from(options.body);
    r2State.store.set(options.key, body);
    r2State.uploads.push(options.key);
  },
  downloadFromR2: async (key: string) => {
    const body = r2State.store.get(key);
    if (!body) {
      const error = new Error("The specified key does not exist.");
      error.name = "NoSuchKey";
      throw error;
    }
    return body;
  },
  deleteFromR2: async (key: string) => {
    if (r2State.failDelete) throw new Error("R2 suppression impossible (mock)");
    r2State.store.delete(key);
  },
  listObjectsUnderPrefix: async () => [],
}));

const docs = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const deleteUserMock = vi.hoisted(() => vi.fn());

vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(() => ({ deleteUser: deleteUserMock })),
}));

vi.mock("firebase-admin/app", () => ({
  getApp: vi.fn(() => ({})),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: (id: string) => ({ path: `${name}/${id}` }),
      where: (field: string, _op: string, valeur: unknown) => ({
        limit: (_n: number) => ({
          get: async () => {
            const correspondants = [...docs.entries()]
              .filter(([cle, donnees]) => cle.startsWith(`${name}/`) && donnees[field] === valeur)
              .map(([cle]) => ({ ref: { path: cle }, id: cle, data: () => docs.get(cle) }));
            return { empty: correspondants.length === 0, size: correspondants.length, docs: correspondants };
          },
        }),
      }),
    }),
    batch: () => ({
      delete: (ref: { path: string }) => {
        docs.delete(ref.path);
      },
      commit: async () => undefined,
    }),
    recursiveDelete: async (ref: { path: string }) => {
      for (const cle of [...docs.keys()]) {
        if (cle === ref.path || cle.startsWith(`${ref.path}/`)) docs.delete(cle);
      }
    },
  },
}));

vi.mock("@/lib/security/authenticated-request", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/security/security-audit", () => ({
  appendSecurityAuditEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

import { requireUser } from "@/lib/security/authenticated-request";
import { unauthorized } from "@/lib/security/http-errors";
import { getIdentity } from "@/lib/identity/r2-identity-store";

import { DELETE } from "./account/route";

const UID = "uid-account-1";

function deleteRequest(): NextRequest {
  return new NextRequest("https://gen3ia.local/api/auth/account", {
    method: "DELETE",
    headers: { authorization: "Bearer jeton-id", origin: "https://gen3ia.local" },
  });
}

function semerIdentite(uid: string): void {
  const maintenant = new Date().toISOString();
  r2State.store.set(
    `identities/${uid}.json`,
    Buffer.from(
      JSON.stringify({
        uid,
        email: "user@example.com",
        emailVerified: true,
        displayName: "Utilisateur Account",
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
        providers: ["password"],
        plan: "free",
        role: "user",
        status: "active",
        createdAt: maintenant,
        updatedAt: maintenant,
        lastLoginAt: maintenant,
        identityVersion: 1,
      }),
    ),
  );
}

beforeEach(() => {
  r2State.store.clear();
  r2State.uploads.length = 0;
  r2State.failDelete = false;
  docs.clear();
  deleteUserMock.mockReset();
  deleteUserMock.mockResolvedValue(undefined);
  vi.mocked(requireUser).mockResolvedValue({ uid: UID } as never);
});

describe("DELETE /api/auth/account — cascade RGPD avec base d'identités R2", () => {
  it("supprime l'identité R2 ET le compte Auth (les deux purges aboutissent)", async () => {
    semerIdentite(UID);
    docs.set("agents/agent-1", { ownerId: UID });
    docs.set("chatMessages/msg-1", { userId: UID });

    const response = await DELETE(deleteRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; deleted: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.deleted.agents).toBe(1);
    expect(body.deleted.identityDeleted).toBe(true);
    // L'identité R2 a disparu de la base.
    await expect(getIdentity(UID)).resolves.toBeNull();
    // Le compte Firebase Auth a bien été supprimé.
    expect(deleteUserMock).toHaveBeenCalledWith(UID);
    // Le cookie de session est effacé.
    expect(response.headers.get("set-cookie")).toContain("gen3ia_session=");
  });

  it("panne R2 → suppression CONTINUÉE : Auth supprimé, réponse 200, identityDeleted:false", async () => {
    semerIdentite(UID);
    r2State.failDelete = true;

    const response = await DELETE(deleteRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; deleted: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.deleted.identityDeleted).toBe(false);
    // L'utilisateur prime : le compte d'authentification est quand même supprimé.
    expect(deleteUserMock).toHaveBeenCalledWith(UID);
  });

  it("non authentifié → 401 (aucune purge déclenchée)", async () => {
    vi.mocked(requireUser).mockRejectedValue(unauthorized());
    const response = await DELETE(deleteRequest());
    expect(response.status).toBe(401);
    expect(deleteUserMock).not.toHaveBeenCalled();
  });
});
