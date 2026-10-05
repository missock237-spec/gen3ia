import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Dépôt agents org-aware (recommandation C) : création avec rattachement
 * validé, lecture/écriture/suppression via la politique centralisée, liste
 * union personnel + organisations (dédupliquée, triée, plafonnée). Les
 * variantes *ForOwner restent inchangées pour les chemins runtime internes.
 */

const docGet = vi.fn();
const docSet = vi.fn();
const docCreate = vi.fn();
const docDelete = vi.fn();
const personalQueryGet = vi.fn();
const orgQueryGet = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  FieldValue: { serverTimestamp: () => ({ __ts: true }) },
  Timestamp: {},
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ get: docGet, set: docSet, create: docCreate, delete: docDelete })),
      where: vi.fn((_field: string) => {
        // Task 101 : la liste personnelle passe par resilientQuery qui pose
        // DÉSORMAIS orderBy (tri serveur) avant limit — chaque maillon du
        // chaînage renvoie un objet complet (orderBy ET limit), le routage
        // reste par champ (ownerId → personnel, autre → organisation).
        const route = (...args: unknown[]) => (_field === "ownerId" ? personalQueryGet(...args) : orgQueryGet(...args));
        const limitBuilder = () => ({
          get: (...args: unknown[]) => route(...args),
        });
        const orderBuilder = () => ({
          orderBy: vi.fn(orderBuilder),
          limit: vi.fn(limitBuilder),
        });
        return {
          orderBy: vi.fn(orderBuilder),
          limit: vi.fn(limitBuilder),
        };
      }),
    })),
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
  createAgentRecord,
  deleteAgentForUser,
  getAgentForUser,
  listAgentsForUser,
  updateAgentForUser,
} from "./repository";

function snapDoc(data: Record<string, unknown> | null) {
  return { exists: data !== null, data: () => data };
}

function baseAgent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ownerId: "u1",
    name: "Agent Org", description: "", type: "universal", skills: [], agentMode: "standard",
    systemPrompt: "Prompt système suffisamment long pour la charte.",
    modelStrategy: "automatic", autonomous: true, subagentsEnabled: true, maxSubagents: 3,
    subAgentIds: [], temperature: 0.7, mcpEnabled: true, authorizationMode: "always_ask",
    maxIterations: 8, tools: [], memoryEnabled: true, webResearchEnabled: true,
    documentGenerationEnabled: true, voiceEnabled: false, status: "active", ...overrides,
  };
}

beforeEach(() => {
  docGet.mockReset(); docSet.mockReset(); docCreate.mockReset(); docDelete.mockReset();
  personalQueryGet.mockReset(); orgQueryGet.mockReset();
  mockedAssertRead.mockReset(); mockedAssertWrite.mockReset();
  mockedAssertAttach.mockReset(); mockedAssertTransfer.mockReset(); mockedListOrgs.mockReset();
  mockedAssertRead.mockResolvedValue({ read: true, write: true, via: "owner" });
  mockedAssertWrite.mockResolvedValue({ read: true, write: true, via: "owner" });
  docGet.mockResolvedValue(snapDoc(baseAgent()));
  docSet.mockResolvedValue(undefined);
  docDelete.mockResolvedValue(undefined);
});

describe("createAgentRecord — rattachement organisationnel", () => {
  it("sans orgId : aucun appel d'attachement (comportement historique)", async () => {
    await createAgentRecord("u1", baseAgent());
    expect(mockedAssertAttach).not.toHaveBeenCalled();
    // Task 96-c : l'écriture passe par la couche résiliente (create).
    const written = docCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(written.ownerId).toBe("u1");
    expect(written.orgId).toBeUndefined();
  });

  it("avec orgId : l'attachement est validé AVANT l'écriture", async () => {
    await createAgentRecord("u1", baseAgent(), { orgId: "org-1" });
    expect(mockedAssertAttach).toHaveBeenCalledWith("u1", "org-1");
    expect(docCreate).toHaveBeenCalledTimes(1);
    const written = docCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(written.orgId).toBe("org-1");
  });

  it("attach refusé : l'écriture n'a JAMAIS lieu", async () => {
    mockedAssertAttach.mockRejectedValue(new Error("Organisation introuvable ou accès refusé."));
    await expect(createAgentRecord("u1", baseAgent(), { orgId: "org-x" })).rejects.toThrow("Organisation introuvable");
    expect(docCreate).not.toHaveBeenCalled();
  });

  it("orgId blanc dans les options : traité comme absent", async () => {
    await createAgentRecord("u1", baseAgent(), { orgId: "   " });
    expect(mockedAssertAttach).not.toHaveBeenCalled();
    const written = docCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(written.orgId).toBeUndefined();
  });
});

describe("getAgentForUser — lecture org-aware", () => {
  it("lecture autorisée → enregistrement mappé", async () => {
    const agent = await getAgentForUser("u2", "a1");
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("Agent Org");
    expect(mockedAssertRead).toHaveBeenCalledWith("u2", { ownerId: "u1", orgId: null });
  });

  it("lecture refusée → null (indiscernable d'un agent absent)", async () => {
    mockedAssertRead.mockRejectedValue(new Error("Ressource introuvable ou accès refusé."));
    expect(await getAgentForUser("u2", "a1")).toBeNull();
  });

  it("agent inexistant → null sans appel de politique", async () => {
    docGet.mockResolvedValue(snapDoc(null));
    expect(await getAgentForUser("u2", "a1")).toBeNull();
    expect(mockedAssertRead).not.toHaveBeenCalled();
  });
});

describe("updateAgentForUser — écriture et transfert", () => {
  it("écriture autorisée : le patch fusionne, ownerId préservé depuis le doc", async () => {
    docGet
      .mockResolvedValueOnce(snapDoc(baseAgent({ ownerId: "u1", orgId: "org-1" })))
      .mockResolvedValueOnce(snapDoc(baseAgent({ ownerId: "u1", orgId: "org-1", name: "Renommé" })));
    const updated = await updateAgentForUser("u2", "a1", { name: "Renommé" });
    expect(mockedAssertWrite).toHaveBeenCalledWith("u2", { ownerId: "u1", orgId: "org-1" });
    expect(updated).not.toBeNull();
    const written = docSet.mock.calls[0][0] as Record<string, unknown>;
    expect(written.name).toBe("Renommé");
    expect(written.ownerId).toBe("u1");
  });

  it("écriture refusée (membre lecture seule) → null sans écriture", async () => {
    mockedAssertWrite.mockRejectedValue(new Error("Action réservée au propriétaire ou aux administrateurs."));
    docGet.mockResolvedValue(snapDoc(baseAgent({ ownerId: "u1", orgId: "org-1" })));
    expect(await updateAgentForUser("u2", "a1", { name: "X" })).toBeNull();
    expect(docSet).not.toHaveBeenCalled();
  });

  it("transfert org : patch.orgId défini → assertOrgTransfer avec la destination", async () => {
    docGet
      .mockResolvedValueOnce(snapDoc(baseAgent({ ownerId: "u1" })))
      .mockResolvedValueOnce(snapDoc(baseAgent({ ownerId: "u1", orgId: "org-9" })));
    await updateAgentForUser("u2", "a1", { orgId: "org-9" });
    expect(mockedAssertTransfer).toHaveBeenCalledWith("u2", { ownerId: "u1", orgId: null }, "org-9");
    const written = docSet.mock.calls[0][0] as Record<string, unknown>;
    expect(written.orgId).toBe("org-9");
  });

  it("détachement : patch.orgId=\"\" → ressource redevenue personnelle", async () => {
    docGet
      .mockResolvedValueOnce(snapDoc(baseAgent({ ownerId: "u1", orgId: "org-1" })))
      .mockResolvedValueOnce(snapDoc(baseAgent({ ownerId: "u1" })));
    await updateAgentForUser("u2", "a1", { orgId: "" });
    const written = docSet.mock.calls[0][0] as Record<string, unknown>;
    expect(written.orgId).toBeUndefined();
  });

  it("sans patch.orgId : l'orgId courant est conservé tel quel", async () => {
    docGet
      .mockResolvedValueOnce(snapDoc(baseAgent({ ownerId: "u1", orgId: "org-1" })))
      .mockResolvedValueOnce(snapDoc(baseAgent({ ownerId: "u1", orgId: "org-1" })));
    await updateAgentForUser("u2", "a1", { name: "Nouveau nom" });
    const written = docSet.mock.calls[0][0] as Record<string, unknown>;
    expect(written.orgId).toBe("org-1");
    expect(mockedAssertTransfer).toHaveBeenCalledWith("u2", { ownerId: "u1", orgId: "org-1" }, undefined);
  });
});

describe("deleteAgentForUser — suppression org-aware", () => {
  it("écriture autorisée → suppression effective, true", async () => {
    docGet.mockResolvedValue(snapDoc(baseAgent({ ownerId: "u1", orgId: "org-1" })));
    expect(await deleteAgentForUser("u2", "a1")).toBe(true);
    expect(docDelete).toHaveBeenCalledTimes(1);
  });

  it("écriture refusée → false sans suppression", async () => {
    mockedAssertWrite.mockRejectedValue(new Error("Action réservée."));
    docGet.mockResolvedValue(snapDoc(baseAgent({ ownerId: "u1", orgId: "org-1" })));
    expect(await deleteAgentForUser("u2", "a1")).toBe(false);
    expect(docDelete).not.toHaveBeenCalled();
  });
});

describe("listAgentsForUser — liste union", () => {
  it("sans organisation : agents personnels uniquement (une seule requête)", async () => {
    personalQueryGet.mockResolvedValue({
      docs: [{ id: "a1", data: () => baseAgent({ status: "active" }) }],
    });
    mockedListOrgs.mockResolvedValue([]);
    const agents = await listAgentsForUser("u1");
    expect(agents.map((a) => a.id)).toEqual(["a1"]);
    expect(orgQueryGet).not.toHaveBeenCalled();
  });

  it("union personnel + org, dédupliquée et triée createdAt desc", async () => {
    personalQueryGet.mockResolvedValue({
      docs: [{ id: "perso", data: () => baseAgent() }],
    });
    mockedListOrgs.mockResolvedValue(["org-1"]);
    orgQueryGet.mockResolvedValue({
      docs: [
        { id: "perso", data: () => baseAgent({ ownerId: "u1" }) },
        { id: "orgdoc", data: () => baseAgent({ ownerId: "u9", orgId: "org-1" }) },
      ],
    });
    const agents = await listAgentsForUser("u1");
    expect(agents.map((a) => a.id).sort()).toEqual(["orgdoc", "perso"]);
    expect(agents).toHaveLength(2);
  });

  it("filtrage : archivés exclus, projectId respecté sur les agents d'org", async () => {
    personalQueryGet.mockResolvedValue({ docs: [] });
    mockedListOrgs.mockResolvedValue(["org-1"]);
    orgQueryGet.mockResolvedValue({
      docs: [
        { id: "arch", data: () => baseAgent({ status: "archived", orgId: "org-1" }) },
        { id: "wrong-project", data: () => baseAgent({ projectId: "p2", orgId: "org-1" }) },
        { id: "good", data: () => baseAgent({ projectId: "p1", orgId: "org-1" }) },
      ],
    });
    const agents = await listAgentsForUser("u1", "p1");
    expect(agents.map((a) => a.id)).toEqual(["good"]);
  });

  it("les orgIds sont chunkés par 30 (limite opérateur in Firestore)", async () => {
    personalQueryGet.mockResolvedValue({ docs: [] });
    mockedListOrgs.mockResolvedValue(Array.from({ length: 65 }, (_, i) => `org-${i}`));
    orgQueryGet.mockResolvedValue({ docs: [] });
    await listAgentsForUser("u1");
    expect(orgQueryGet).toHaveBeenCalledTimes(3);
  });

  it("plafond global 100 agents (les plus récents d'abord)", async () => {
    const many = Array.from({ length: 140 }, (_, i) => ({
      id: `org-${i}`,
      data: () => baseAgent({ createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(), orgId: "org-1" }),
    }));
    personalQueryGet.mockResolvedValue({ docs: [] });
    mockedListOrgs.mockResolvedValue(["org-1"]);
    orgQueryGet.mockResolvedValue({ docs: many });
    const agents = await listAgentsForUser("u1");
    expect(agents).toHaveLength(100);
  });
});
