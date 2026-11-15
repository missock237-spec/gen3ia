import { describe, expect, it, vi } from "vitest";

const verifyFirebaseRequest = vi.fn();

vi.mock("@/lib/auth/firebase", () => ({
  verifyFirebaseRequest: (...args: unknown[]) => verifyFirebaseRequest(...args),
}));

vi.mock("@/lib/security/admin-access", () => ({
  requireAdmin: vi.fn(),
}));

import { withAuth, withAdmin } from "@/lib/server/with-auth";
import { requireAdmin } from "@/lib/security/admin-access";
import { HttpError } from "@/lib/security/http-errors";

function requete(headers: Record<string, string> = {}) {
  return {
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Request;
}

describe("withAuth — primitive de garde de route", () => {
  it("passe l'identité vérifiée au handler", async () => {
    verifyFirebaseRequest.mockResolvedValueOnce({ uid: "u-1", email: "a@b.c" });
    const handler = vi.fn(async () => new Response("ok"));
    const route = withAuth(handler);

    const reponse = await route(requete(), undefined);

    expect(reponse.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    const [req, ctx, user] = handler.mock.calls[0]!;
    expect(user).toMatchObject({ uid: "u-1" });
    expect(req).toBeDefined();
    expect(ctx).toBeUndefined();
  });

  it("renvoie 401 uniforme sans exécuter le handler si l'identité est absente", async () => {
    verifyFirebaseRequest.mockRejectedValueOnce(new Error("Missing authorization header."));
    const handler = vi.fn(async () => new Response("jamais"));
    const route = withAuth(handler);

    const reponse = await route(requete(), undefined);
    const corps = (await reponse.json()) as { code: string };

    expect(reponse.status).toBe(401);
    expect(corps.code).toBe("AUTH_REQUIRED");
    expect(handler).not.toHaveBeenCalled();
  });

  it("transfère le contexte de route ({ params }) tel quel", async () => {
    verifyFirebaseRequest.mockResolvedValueOnce({ uid: "u-2" });
    const handler = vi.fn(async () => new Response("ok"));
    const route = withAuth<{ params: Promise<{ id: string }> }>(handler);
    const contexte = { params: Promise.resolve({ id: "abc" }) };

    await route(requete(), contexte);

    expect(handler.mock.calls[0]![1]).toBe(contexte);
  });
});

describe("withAdmin — primitive de garde admin", () => {
  it("passe l'admin vérifié au handler", async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce({
      uid: "admin-1",
      claims: { admin: true },
    } as Awaited<ReturnType<typeof requireAdmin>>);
    const handler = vi.fn(async () => new Response("ok"));
    const route = withAdmin(handler);

    const reponse = await route(requete() as never, undefined);

    expect(reponse.status).toBe(200);
    expect(handler.mock.calls[0]![2]).toMatchObject({ uid: "admin-1" });
  });

  it("convertit HttpError (401/403 de requireAdmin) en réponse JSON propre", async () => {
    vi.mocked(requireAdmin).mockRejectedValueOnce(
      new HttpError(403, "Administrator access required.", "FORBIDDEN"),
    );
    const handler = vi.fn(async () => new Response("jamais"));
    const route = withAdmin(handler);

    const reponse = await route(requete() as never, undefined);
    const corps = (await reponse.json()) as { code: string };

    expect(reponse.status).toBe(403);
    expect(corps.code).toBe("FORBIDDEN");
    expect(handler).not.toHaveBeenCalled();
  });

  it("laisse remonter les erreurs non HttpError (panne réelle → 500 runtime)", async () => {
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error("Firestore indisponible"));
    const route = withAdmin(async () => new Response("jamais"));

    await expect(route(requete() as never, undefined)).rejects.toThrow(
      "Firestore indisponible",
    );
  });
});
