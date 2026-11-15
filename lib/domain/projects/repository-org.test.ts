import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Dépôt projets org-aware (Task 58, priorité #1 — migration orgId) :
 * création avec rattachement validé AVANT écriture, lecture/écriture/
 * suppression via la politique centralisée (matrice resource-access),
 * liste UNION personnel + organisations dédupliquée et plafonnée,
 * transfert d'organisation (attachement/détachement). La migration est
 * LAZY : aucun backfill, un projet hérite son orgId à la création ou au
 * fil des mises à jour — zéro coupure de service.
 */

const docGet = vi.fn();
const docSet = vi.fn();
const docUpdate = vi.fn();
const docDelete = vi.fn();
const batchUpdate = vi.fn();
const batchDelete = vi.fn();
const batchCommit = vi.fn();
const personalQueryGet = vi.fn();
const orgQueryGet = vi.fn();
const conversationsQueryGet = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  FieldValue: {
    serverTimestamp: () => ({ __ts: true }),
    delete: () => ({ __deleted: true }),
  },
  Timestamp: {},
  adminDb: {
    collection: vi.fn((name: string) => {
      if (name === "chatConversations") {
        return {
          where: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => ({ get: (...args: unknown[]) => conversationsQueryGet(...args) })),
            })),
          })),
        };
      }
      return {
        doc: vi.fn(() => ({ get: docGet, set: docSet, update: docUpdate, delete: docDelete })),
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => ({ get: (...args: unknown[]) => personalQueryGet(...args) })),
          })),
          limit: vi.fn(() => ({ get: (...args: unknown[]) => orgQueryGet(...args) })),
        })),
        batch: undefined,
      };
    }),
    batch: vi.fn(() => ({ update: batchUpdate, delete: batchDelete, commit: batchCommit })),
  },
}));

const mockedAssertRead = vi.fn();
const mockedAssertWrite = vi.fn();
const mockedAssertAttach = vi.fn();
const mockedAssertTransfer = vi.fn();
const mockedListOrgs = vi.fn();
vi.mock("@/lib/tenants/resource-access", () => ({
  assertResourceRead: (...args: unknown[]) => mockedAssertRead(...args),
  assertResourceWrite: (...args: unknown[]) => mockedAssertWrite(...args),
  assertOrgAttach: (...args: unknown[]) => mockedAssertAttach(...args),
  assertOrgTransfer: (...args: unknown[]) => mockedAssertTransfer(...args),
  listUserOrgIds: (...args: unknown[]) => mockedListOrgs(...args),
}));

import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from "./repository";

function snapDoc(data: Record<string, unknown> | null) {
  return { id: "p1", exists: data !== null, data: () => data };
}

function baseProject(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: "u1",
    name: "Projet Org",
    description: "",
    instructions: "",
    authorizedConnectors: [],
    privacyRules: "",
    status: "active",
    createdAt: new Date("2026-10-01T10:00:00Z"),
    updatedAt: new Date("2026-10-01T12:00:00Z"),
    ...overrides,
  };
}

function queryDoc(id: string, data: Record<string, unknown>) {
  return { id, data: () => data };
}

beforeEach(() => {
  docGet.mockReset(); docSet.mockReset(); docUpdate.mockReset(); docDelete.mockReset();
  batchUpdate.mockReset(); batchDelete.mockReset(); batchCommit.mockReset();
  personalQueryGet.mockReset(); orgQueryGet.mockReset(); conversationsQueryGet.mockReset();
  mockedAssertRead.mockReset(); mockedAssertWrite.mockReset();
  mockedAssertAttach.mockReset(); mockedAssertTransfer.mockReset(); mockedListOrgs.mockReset();
  mockedAssertRead.mockResolvedValue({ read: true, write: true, via: "owner" });
  mockedAssertWrite.mockResolvedValue({ read: true, write: true, via: "owner" });
  batchCommit.mockResolvedValue(undefined);
  conversationsQueryGet.mockResolvedValue({ docs: [] });
});

describe("createProject — rattachement d'organisation", () => {
  it("sans orgId : projet personnel, AUCUN appel d'attachement (comportement historique)", async () => {
    docGet.mockResolvedValue(snapDoc(baseProject()));
    await createProject("u1", { name: "Mon projet" });
    expect(mockedAssertAttach).not.toHaveBeenCalled();
    const written = docSet.mock.calls[0][0] as Record<string, unknown>;
    expect(written.orgId).toBeUndefined();
  });

  it("avec orgId : l'attachement est validé AVANT l'écriture, l'orgId est documenté", async () => {
    docGet.mockResolvedValue(snapDoc(baseProject({ orgId: "org-1" })));
    await createProject("u1", { name: "Projet équipe" }, { orgId: "org-1" });
    expect(mockedAssertAttach).toHaveBeenCalledWith("u1", "org-1");
    expect(mockedAssertAttach.mock.invocationCallOrder[0])
      .toBeLessThan(docSet.mock.invocationCallOrder[0]);
    const written = docSet.mock.calls[0][0] as Record<string, unknown>;
    expect(written.orgId).toBe("org-1");
  });

  it("attachement refusé : AUCUNE écriture", async () => {
    mockedAssertAttach.mockRejectedValue(new Error("Organisation introuvable ou accès refusé."));
    await expect(createProject("u1", { name: "X" }, { orgId: "org-hors" })).rejects.toThrow(/Organisation introuvable/);
    expect(docSet).not.toHaveBeenCalled();
  });
});

describe("listProjects — vue UNION personnel + organisations", () => {
  it("sans organisation : requête personnelle seule", async () => {
    personalQueryGet.mockResolvedValue({ docs: [queryDoc("p1", baseProject())] });
    mockedListOrgs.mockResolvedValue([]);
    const projects = await listProjects("u1");
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ id: "p1", name: "Projet Org" });
    expect(orgQueryGet).not.toHaveBeenCalled();
  });

  it("union dédupliquée personnel + orgs, tri updatedAt desc, plafond appliqué", async () => {
    personalQueryGet.mockResolvedValue({
      docs: [
        queryDoc("p1", baseProject({ updatedAt: new Date("2026-10-02T10:00:00Z") })),
        queryDoc("p2", baseProject({ updatedAt: new Date("2026-10-01T10:00:00Z") })),
      ],
    });
    mockedListOrgs.mockResolvedValue(["org-1"]);
    orgQueryGet.mockResolvedValue({
      docs: [
        queryDoc("p2", baseProject({ orgId: "org-1" })), // doublon (membre ET personnel)
        queryDoc("p3", baseProject({ userId: "u2", orgId: "org-1", updatedAt: new Date("2026-10-03T10:00:00Z") })),
      ],
    });
    const projects = await listProjects("u1");
    expect(projects.map((p) => p.id)).toEqual(["p3", "p1", "p2"]); // tri desc
    expect(projects.filter((p) => p.id === "p2")).toHaveLength(1); // dédupliqué
    expect(projects.find((p) => p.id === "p3")?.orgId).toBe("org-1");
  });

  it("plus de 30 organisations : requêtes par lots ≤ 30 (limite Firestore `in`)", async () => {
    personalQueryGet.mockResolvedValue({ docs: [] });
    mockedListOrgs.mockResolvedValue(Array.from({ length: 65 }, (_, i) => `org-${i}`));
    orgQueryGet.mockResolvedValue({ docs: [] });
    await listProjects("u1");
    expect(orgQueryGet).toHaveBeenCalledTimes(3); // 30 + 30 + 5
  });
});

describe("getProject — lecture org-aware", () => {
  it("propriétaire : accès intégral", async () => {
    docGet.mockResolvedValue(snapDoc(baseProject()));
    const project = await getProject("u1", "p1");
    expect(project).toMatchObject({ id: "p1", userId: "u1" });
    expect(mockedAssertRead).toHaveBeenCalledWith("u1", { ownerId: "u1", orgId: null });
  });

  it("membre d'organisation : lecture accordée par la politique centralisée", async () => {
    docGet.mockResolvedValue(snapDoc(baseProject({ userId: "u2", orgId: "org-1" })));
    mockedAssertRead.mockResolvedValue({ read: true, write: false, via: "org-member" });
    const project = await getProject("u1", "p1");
    expect(project).toMatchObject({ id: "p1", orgId: "org-1" });
  });

  it("non-membre : dénégation indiscernable d'un projet absent (null, anti-énumération)", async () => {
    docGet.mockResolvedValue(snapDoc(baseProject({ userId: "u2" })));
    mockedAssertRead.mockRejectedValue(new Error("denied"));
    const project = await getProject("u1", "p1");
    expect(project).toBeNull();
  });
});

describe("updateProject — écriture + transfert d'organisation", () => {
  it("modification simple : write policy appliquée, champs bornés", async () => {
    docGet.mockResolvedValue(snapDoc(baseProject()));
    await updateProject("u1", "p1", { name: "Nouveau nom" });
    expect(mockedAssertWrite).toHaveBeenCalledWith("u1", { ownerId: "u1", orgId: null });
    const update = docUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(update.name).toBe("Nouveau nom");
  });

  it("transfert vers une organisation : destination validée (assertOrgTransfer) puis orgId écrit", async () => {
    docGet.mockResolvedValue(snapDoc(baseProject()));
    await updateProject("u1", "p1", { orgId: "org-9" });
    expect(mockedAssertTransfer).toHaveBeenCalledWith("u1", { ownerId: "u1", orgId: null }, "org-9");
    const update = docUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(update.orgId).toBe("org-9");
  });

  it("détachement (orgId vide) : champ supprimé (sentinelle Firestore), retour personnel", async () => {
    docGet.mockResolvedValue(snapDoc(baseProject({ orgId: "org-1" })));
    await updateProject("u1", "p1", { orgId: "" });
    const update = docUpdate.mock.calls[0][0] as Record<string, unknown>;
    // Le champ est remplacé par la sentinelle de suppression Firestore
    // (DeleteTransform) — jamais une chaîne vide persistée.
    expect(typeof update.orgId).toBe("object");
    expect(update.orgId).not.toBeNull();
  });

  it("écriture refusée (simple membre) : AUCUNE mise à jour", async () => {
    docGet.mockResolvedValue(snapDoc(baseProject({ userId: "u2", orgId: "org-1" })));
    mockedAssertWrite.mockRejectedValue(new Error("Action réservée au propriétaire ou aux administrateurs."));
    await expect(updateProject("u1", "p1", { name: "X" })).rejects.toThrow(/réservée/);
    expect(docUpdate).not.toHaveBeenCalled();
  });
});

describe("deleteProject — suppression org-aware", () => {
  it("propriétaire : conversations détachées puis projet supprimé", async () => {
    docGet.mockResolvedValue(snapDoc(baseProject()));
    conversationsQueryGet.mockResolvedValue({ docs: [{ ref: "conv-ref" }] });
    await deleteProject("u1", "p1");
    expect(mockedAssertWrite).toHaveBeenCalledWith("u1", { ownerId: "u1", orgId: null });
    const [convRef, patch] = batchUpdate.mock.calls[0] as [string, Record<string, unknown>];
    expect(convRef).toBe("conv-ref");
    expect(typeof patch.projectId).toBe("object"); // sentinelle de détachement
    expect(batchDelete).toHaveBeenCalled();
    expect(batchCommit).toHaveBeenCalled();
  });

  it("owner/admin d'organisation : suppression autorisée via la write policy", async () => {
    docGet.mockResolvedValue(snapDoc(baseProject({ userId: "u2", orgId: "org-1" })));
    mockedAssertWrite.mockResolvedValue({ read: true, write: true, via: "org-admin" });
    await deleteProject("u1", "p1");
    expect(mockedAssertWrite).toHaveBeenCalledWith("u1", { ownerId: "u2", orgId: "org-1" });
    expect(batchCommit).toHaveBeenCalled();
  });

  it("simple membre : suppression refusée (write policy)", async () => {
    docGet.mockResolvedValue(snapDoc(baseProject({ userId: "u2", orgId: "org-1" })));
    mockedAssertWrite.mockRejectedValue(new Error("Action réservée au propriétaire ou aux administrateurs."));
    await expect(deleteProject("u1", "p1")).rejects.toThrow(/réservée/);
    expect(batchCommit).not.toHaveBeenCalled();
  });
});
