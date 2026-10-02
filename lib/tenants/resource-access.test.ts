import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Matrice d'accès multi-tenant (recommandation C) — le cœur du cloisonnement
 * : une ressource personnelle reste propriétaire-seul ; une ressource
 * rattachée à une organisation est lisible par ses membres, gérable par
 * owner/admin, et JAMAIS accessible à un tiers. La dénégation doit être
 * indiscernable (mêmes messages) pour ne pas divulguer de structure d'accès.
 */

const indexWhereGet = vi.fn();
const mockedRequireOrgContext = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => ({
          get: (...args: unknown[]) => indexWhereGet(...args),
        })),
      })),
    })),
  },
}));

vi.mock("./organizations", () => ({
  requireOrgContext: (...args: unknown[]) => mockedRequireOrgContext(...args),
}));

import {
  ResourceAccessError,
  assertOrgAttach,
  assertOrgTransfer,
  assertResourceRead,
  assertResourceWrite,
  listUserOrgIds,
  resolveResourceAccess,
} from "./resource-access";

const OWNER = { ownerId: "u1", orgId: null };
const ORG_RESOURCE = { ownerId: "u1", orgId: "org-1" };

beforeEach(() => {
  indexWhereGet.mockReset();
  mockedRequireOrgContext.mockReset();
});

describe("resolveResourceAccess — matrice personnelle", () => {
  it("le propriétaire d'une ressource personnelle lit et écrit (via owner)", async () => {
    const access = await resolveResourceAccess("u1", OWNER);
    expect(access).toEqual({ read: true, write: true, via: "owner" });
  });

  it("un étranger n'a AUCUN accès à une ressource personnelle", async () => {
    const access = await resolveResourceAccess("u2", OWNER);
    expect(access).toEqual({ read: false, write: false, via: "none" });
  });

  it("un userId vide n'a aucun accès (garde défensive)", async () => {
    const access = await resolveResourceAccess("", OWNER);
    expect(access).toEqual({ read: false, write: false, via: "none" });
  });

  it("orgId vide ou blanc équivaut à une ressource personnelle (étranger refusé)", async () => {
    const access = await resolveResourceAccess("u2", { ownerId: "u1", orgId: "   " });
    expect(access).toEqual({ read: false, write: false, via: "none" });
    expect(mockedRequireOrgContext).not.toHaveBeenCalled();
  });
});

describe("resolveResourceAccess — matrice organisationnelle", () => {
  it("rôle org owner : lecture + écriture (via org-owner)", async () => {
    mockedRequireOrgContext.mockResolvedValue({ orgId: "org-1", role: "owner", plan: "pro", name: "Org" });
    const access = await resolveResourceAccess("u2", ORG_RESOURCE);
    expect(access).toEqual({ read: true, write: true, via: "org-owner" });
    expect(mockedRequireOrgContext).toHaveBeenCalledWith("u2", "org-1");
  });

  it("rôle org admin : lecture + écriture (via org-admin)", async () => {
    mockedRequireOrgContext.mockResolvedValue({ orgId: "org-1", role: "admin", plan: "pro", name: "Org" });
    const access = await resolveResourceAccess("u2", ORG_RESOURCE);
    expect(access).toEqual({ read: true, write: true, via: "org-admin" });
  });

  it("rôle org member : lecture SEULE (via org-member) — pas de gestion", async () => {
    mockedRequireOrgContext.mockResolvedValue({ orgId: "org-1", role: "member", plan: "free", name: "Org" });
    const access = await resolveResourceAccess("u2", ORG_RESOURCE);
    expect(access).toEqual({ read: true, write: false, via: "org-member" });
  });

  it("non-membre de l'org : aucun accès (cloisonnement strict)", async () => {
    mockedRequireOrgContext.mockRejectedValue(new Error("Organisation introuvable ou accès refusé."));
    const access = await resolveResourceAccess("u2", ORG_RESOURCE);
    expect(access).toEqual({ read: false, write: false, via: "none" });
  });

  it("le propriétaire garde l'accès intégral même s'il a quitté la org", async () => {
    const access = await resolveResourceAccess("u1", ORG_RESOURCE);
    expect(access).toEqual({ read: true, write: true, via: "owner" });
    expect(mockedRequireOrgContext).not.toHaveBeenCalled();
  });
});

describe("assertResourceRead / assertResourceWrite", () => {
  it("assertResourceRead traverse pour un membre (lecture)", async () => {
    mockedRequireOrgContext.mockResolvedValue({ orgId: "org-1", role: "member", plan: "free", name: "Org" });
    const access = await assertResourceRead("u2", ORG_RESOURCE);
    expect(access.read).toBe(true);
  });

  it("assertResourceRead lève ResourceAccessError 403 pour un tiers", async () => {
    const error = await assertResourceRead("u2", OWNER).catch((e) => e);
    expect(error).toBeInstanceOf(ResourceAccessError);
    expect(error.status).toBe(403);
  });

  it("assertResourceWrite lève pour un membre en lecture seule", async () => {
    mockedRequireOrgContext.mockResolvedValue({ orgId: "org-1", role: "member", plan: "free", name: "Org" });
    const error = await assertResourceWrite("u2", ORG_RESOURCE).catch((e) => e);
    expect(error).toBeInstanceOf(ResourceAccessError);
    expect(error.status).toBe(403);
  });

  it("dénégation indiscernable : le message du membre en lecture = celui d'un tiers", async () => {
    const memberError = await assertResourceWrite("u2", ORG_RESOURCE).catch((e) => e);
    const strangerError = await assertResourceWrite("u2", OWNER).catch((e) => e);
    expect(memberError.message).toBe(strangerError.message);
  });

  it("assertResourceWrite traverse pour un admin d'org", async () => {
    mockedRequireOrgContext.mockResolvedValue({ orgId: "org-1", role: "admin", plan: "pro", name: "Org" });
    const access = await assertResourceWrite("u2", ORG_RESOURCE);
    expect(access.write).toBe(true);
  });
});

describe("assertOrgAttach / assertOrgTransfer", () => {
  it("attach : membre (tous rôles) → contexte retourné", async () => {
    mockedRequireOrgContext.mockResolvedValue({ orgId: "org-1", role: "member", plan: "free", name: "Org" });
    const context = await assertOrgAttach("u2", "org-1");
    expect(context.role).toBe("member");
  });

  it("attach : non-membre → ResourceAccessError 403", async () => {
    mockedRequireOrgContext.mockRejectedValue(new Error("refusé"));
    const error = await assertOrgAttach("u2", "org-1").catch((e) => e);
    expect(error).toBeInstanceOf(ResourceAccessError);
    expect(error.status).toBe(403);
  });

  it("attach : orgId vide → 400 (jamais de rattachement ambigu)", async () => {
    const error = await assertOrgAttach("u1", "  ").catch((e) => e);
    expect(error).toBeInstanceOf(ResourceAccessError);
    expect(error.status).toBe(400);
    expect(mockedRequireOrgContext).not.toHaveBeenCalled();
  });

  it("transfer : undefined = pas de changement (no-op)", async () => {
    await expect(assertOrgTransfer("u1", OWNER, undefined)).resolves.toBeUndefined();
    expect(mockedRequireOrgContext).not.toHaveBeenCalled();
  });

  it("transfer : détachement (\"\") autorisé sans vérification d'org", async () => {
    await expect(assertOrgTransfer("u1", ORG_RESOURCE, "")).resolves.toBeUndefined();
    expect(mockedRequireOrgContext).not.toHaveBeenCalled();
  });

  it("transfer : destination dont l'appelant est membre → ok", async () => {
    mockedRequireOrgContext.mockResolvedValue({ orgId: "org-9", role: "admin", plan: "pro", name: "Org9" });
    await expect(assertOrgTransfer("u2", OWNER, "org-9")).resolves.toBeUndefined();
    expect(mockedRequireOrgContext).toHaveBeenCalledWith("u2", "org-9");
  });

  it("transfer : destination hors membership → ResourceAccessError", async () => {
    mockedRequireOrgContext.mockRejectedValue(new Error("refusé"));
    await expect(assertOrgTransfer("u2", OWNER, "org-9")).rejects.toBeInstanceOf(ResourceAccessError);
  });
});

describe("listUserOrgIds — index user→org", () => {
  it("déduit, filtre les vides et borne la liste", async () => {
    indexWhereGet.mockResolvedValue({
      docs: [
        { data: () => ({ orgId: "org-1" }) },
        { data: () => ({ orgId: "org-2" }) },
        { data: () => ({ orgId: "org-1" }) },
        { data: () => ({ orgId: "" }) },
        { data: () => ({}) },
      ],
    });
    const ids = await listUserOrgIds("u1");
    expect(ids).toEqual(["org-1", "org-2"]);
  });

  it("userId vide → liste vide sans requête", async () => {
    const ids = await listUserOrgIds("");
    expect(ids).toEqual([]);
    expect(indexWhereGet).not.toHaveBeenCalled();
  });
});
