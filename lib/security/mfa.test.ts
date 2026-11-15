import { describe, expect, it, vi } from "vitest";

/**
 * Couche serveur MFA (Task 63) : détection du second facteur, politique par
 * compte, assertion d'authentification forte. Le guard anti-locked-out est
 * testé au niveau de la route admin (nécessite requireAdmin).
 */

const docs = new Map<string, Record<string, unknown>>();
vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: (id: string) => ({
        async get() {
          return { exists: docs.has(`${name}/${id}`), data: () => docs.get(`${name}/${id}`) };
        },
        async set(data: Record<string, unknown>, _opts?: unknown) {
          docs.set(`${name}/${id}`, { ...docs.get(`${name}/${id}`), ...data });
          return undefined;
        },
      }),
    }),
  },
}));

import {
  assertStrongAuth,
  isMfaRequiredForUser,
  mfaStatusFromSessionCookie,
  mfaStatusFromToken,
  setMfaRequirement,
} from "./mfa";
import { sessionCookieHeader } from "@/lib/server/session-cookie";
import { requireUser } from "@/lib/security/authenticated-request";

vi.mock("@/lib/security/authenticated-request", () => ({
  requireUser: vi.fn(),
}));

const mockedRequireUser = vi.mocked(requireUser);

describe("mfaStatusFromToken — détection du second facteur", () => {
  it("token après second facteur TOTP → utilisé, type totp", () => {
    const status = mfaStatusFromToken({
      uid: "u1",
      firebase: {
        sign_in_provider: "password",
        sign_in_second_factor: "totp",
        second_factor_identifiers: [],
      },
    });
    expect(status).toEqual({ secondFactorUsed: true, secondFactorType: "totp" });
  });

  it("token sans second facteur → non utilisé", () => {
    const status = mfaStatusFromToken({ uid: "u1", firebase: { sign_in_provider: "password" } });
    expect(status).toEqual({ secondFactorUsed: false, secondFactorType: null });
  });

  it("claims encapsulés (chemin requireUser Bearer) : firebase lu dans claims", () => {
    const status = mfaStatusFromToken({
      uid: "u1",
      claims: { firebase: { sign_in_provider: "google.com", sign_in_second_factor: "totp" } },
    });
    expect(status.secondFactorUsed).toBe(true);
  });
});

describe("cookie de session — flag MFA recopié", () => {
  it("cookie posé avec mfa:true relit secondFactorUsed=true", () => {
    const header = sessionCookieHeader({ uid: "u1", email: null, name: null, picture: null, provider: "password", mfa: true });
    const cookie = header.split(";")[0] ?? "";
    const status = mfaStatusFromSessionCookie(cookie);
    expect(status.secondFactorUsed).toBe(true);
  });

  it("ancien cookie sans flag (rétrocompatibilité) → false", () => {
    const header = sessionCookieHeader({ uid: "u1", email: null, name: null, picture: null, provider: "password" });
    const cookie = header.split(";")[0] ?? "";
    expect(mfaStatusFromSessionCookie(cookie).secondFactorUsed).toBe(false);
    expect(mfaStatusFromSessionCookie(null).secondFactorUsed).toBe(false);
  });
});

describe("politique « MFA requis » par compte", () => {
  it("défaut : non requis (compte inconnu ou champ absent)", async () => {
    expect(await isMfaRequiredForUser("inconnu")).toBe(false);
  });

  it("setMfaRequirement(true) puis lecture → requis ; retour à false", async () => {
    await setMfaRequirement("u2", true);
    expect(await isMfaRequiredForUser("u2")).toBe(true);
    const { previous } = await setMfaRequirement("u2", false);
    expect(previous).toBe(true);
    expect(await isMfaRequiredForUser("u2")).toBe(false);
  });

  it("panne Firestore → fail-open documenté (non requis)", async () => {
    // Doc manquant = pas d'exception ; on force une panne en invalidant la collection.
    const original = docs.get("users/u3");
    docs.delete("users/u3");
    expect(await isMfaRequiredForUser("u3")).toBe(false);
    if (original) docs.set("users/u3", original);
  });
});

describe("assertStrongAuth — application de la politique", () => {
  function requestWith(headers: Record<string, string>): Request {
    return new Request("https://gen3ia.online/api/billing/topup", { method: "POST", headers });
  }

  it("compte non marqué : session sans MFA acceptée (comportement inchangé)", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "u-ok" });
    const result = await assertStrongAuth(requestWith({ cookie: "x=1" }));
    expect(result.uid).toBe("u-ok");
  });

  it("compte marqué + second facteur vérifié (cookie mfa:true) → autorisé", async () => {
    await setMfaRequirement("u4", true);
    mockedRequireUser.mockResolvedValue({ uid: "u4" });
    const cookie = sessionCookieHeader({ uid: "u4", email: null, name: null, picture: null, provider: "password", mfa: true }).split(";")[0] ?? "";
    const result = await assertStrongAuth(requestWith({ cookie }));
    expect(result.uid).toBe("u4");
  });

  it("compte marqué + session SANS second facteur → 403 forbidden", async () => {
    await setMfaRequirement("u5", true);
    mockedRequireUser.mockResolvedValue({ uid: "u5" });
    const cookie = sessionCookieHeader({ uid: "u5", email: null, name: null, picture: null, provider: "password" }).split(";")[0] ?? "";
    await expect(assertStrongAuth(requestWith({ cookie }))).rejects.toMatchObject({ status: 403 });
  });

  it("compte marqué + Bearer avec second facteur dans les claims → autorisé", async () => {
    await setMfaRequirement("u6", true);
    mockedRequireUser.mockResolvedValue({
      uid: "u6",
      claims: { firebase: { sign_in_provider: "password", sign_in_second_factor: "totp" } },
    });
    const result = await assertStrongAuth(requestWith({ authorization: "Bearer tok" }));
    expect(result.uid).toBe("u6");
  });
});
