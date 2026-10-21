import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Garde « agent système réservé » (demande utilisateur n°5) :
 *  - utilisateur standard connecté → HttpError 403 avec le message clair
 *    « réservé au système IA » (code FORBIDDEN) ;
 *  - admin (custom claim `admin: true`) → autorisé (accès d'exploitation
 *    conservé, même sémantique que lib/security/admin-access.ts) ;
 *  - requête anonyme → 401 propagé tel quel (comportement requireUser).
 */

const mockedRequireUser = vi.fn();

vi.mock("./authenticated-request", () => ({
  requireUser: (...args: unknown[]) => mockedRequireUser(...args),
}));

import { requireAgentSystemAccess, AGENT_SYSTEM_RESERVED_MESSAGE } from "./agent-system-access";
import { HttpError } from "./http-errors";
import { NextRequest } from "next/server";

function fakeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/agents", { method: "GET" });
}

beforeEach(() => {
  mockedRequireUser.mockReset();
});

describe("requireAgentSystemAccess", () => {
  it("autorise l'admin (claims.admin === true) et renvoie l'utilisateur", async () => {
    const admin = { uid: "admin-1", email: "admin@gen3ia.online", claims: { admin: true } };
    mockedRequireUser.mockResolvedValue(admin);
    const result = await requireAgentSystemAccess(fakeRequest());
    expect(result).toBe(admin);
    expect(mockedRequireUser).toHaveBeenCalledTimes(1);
  });

  it("refuse l'utilisateur standard avec 403 et le message « réservé au système IA »", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "user-1", claims: {} });
    await expect(requireAgentSystemAccess(fakeRequest())).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: AGENT_SYSTEM_RESERVED_MESSAGE,
    });
  });

  it("refuse aussi un utilisateur sans claims (session cookie)", async () => {
    mockedRequireUser.mockResolvedValue({ uid: "user-2" });
    const error = await requireAgentSystemAccess(fakeRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(403);
    expect((error as HttpError).message).toContain("réservé au système IA");
  });

  it("propage le 401 anonyme tel quel (jamais converti en 403 ni 500)", async () => {
    mockedRequireUser.mockRejectedValue(new HttpError(401, "Authentification requise.", "AUTH_REQUIRED"));
    await expect(requireAgentSystemAccess(fakeRequest())).rejects.toMatchObject({ status: 401 });
  });
});
