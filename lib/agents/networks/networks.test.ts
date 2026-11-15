import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RÉSEAUX D'AGENTS PERSISTANTS (concepts #3 « Agent-as-a-Company » et #8
 * « Personal AI Network ») : invariants de composition, dépôt propriétaire-
 * scopé (membres réels + actifs, orgId validé, 404 anti-énumération),
 * messagerie agent-à-agent bornée au MÊME réseau, outils d'équipe, plan de
 * mission d'équipe (coordinateur → membres → synthèse) et configuration
 * runtime à liste blanche stricte.
 */

const docSet = vi.fn();
const docGet = vi.fn();
const docUpdate = vi.fn();
const docDelete = vi.fn();
const queryGet = vi.fn();

function chainableQuery() {
  const builder: Record<string, unknown> = {
    where: vi.fn(() => builder),
    orderBy: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    get: (...args: unknown[]) => queryGet(...args),
  };
  return builder;
}

const networkBuilder = chainableQuery();
const messageBuilder = chainableQuery();

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn((name: string) => ({
      doc: vi.fn(() => ({ set: docSet, get: docGet, update: docUpdate, delete: docDelete })),
      ...(name === "agentNetworks" ? { where: networkBuilder.where, orderBy: networkBuilder.orderBy, limit: networkBuilder.limit } : {}),
      ...(name === "agentMessages" ? { where: messageBuilder.where, orderBy: messageBuilder.orderBy, limit: messageBuilder.limit } : {}),
    })),
  },
}));

const getAgentForUserMock = vi.fn();
vi.mock("@/lib/agents/repository", () => ({
  getAgentForUser: (...args: unknown[]) => getAgentForUserMock(...args),
}));

const assertOrgAttachMock = vi.fn();
vi.mock("@/lib/tenants/resource-access", () => ({
  assertOrgAttach: (...args: unknown[]) => assertOrgAttachMock(...args),
}));

import { validateNetworkInvariants } from "./types";
import { createNetwork, getNetwork, listNetworks, updateNetwork, deleteNetwork } from "./repository";
import { canAgentsExchange, sendAgentMessage, listAgentInbox, markMessageRead } from "./messages";
import { buildNetworkMissionPlan, networkRuntimeAgentConfig, networkExecutionPolicy } from "./runner";
import type { NetworkDoc, NetworkView } from "./types";

const AGENT_RECORD = (id: string) => ({ id, name: `Agent ${id}`, status: "active", type: "general" });

function networkDoc(overrides: Partial<NetworkDoc> = {}): NetworkDoc {
  return {
    id: "net-1",
    userId: "u1",
    name: "Équipe Marketing",
    topology: "coordinator",
    members: [
      { agentId: "a-coord", role: "Coordinateur", department: "Direction" },
      { agentId: "a-redac", role: "Rédacteur", department: "Contenu" },
    ],
    coordinatorAgentId: "a-coord",
    status: "active",
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function viewOf(doc: NetworkDoc): NetworkView {
  const { userId: _userId, ...rest } = doc;
  return rest as unknown as NetworkView;
}

beforeEach(() => {
  docSet.mockReset();
  docGet.mockReset();
  docUpdate.mockReset();
  docDelete.mockReset();
  queryGet.mockReset();
  getAgentForUserMock.mockReset();
  assertOrgAttachMock.mockReset();
  getAgentForUserMock.mockImplementation(async (_userId: string, agentId: string) => AGENT_RECORD(agentId));
});

describe("invariants de composition (purs)", () => {
  it("topologie coordinator : coordinateur requis et membre", () => {
    expect(validateNetworkInvariants({ topology: "coordinator", members: [{ agentId: "a", role: "r" }], coordinatorAgentId: "a" })).toEqual({ ok: true });
    expect(validateNetworkInvariants({ topology: "coordinator", members: [{ agentId: "a", role: "r" }] })).toEqual({ ok: false, error: expect.stringContaining("coordinateur") });
    expect(validateNetworkInvariants({ topology: "coordinator", members: [{ agentId: "a", role: "r" }], coordinatorAgentId: "b" })).toEqual({ ok: false, error: expect.stringContaining("membre") });
  });

  it("agents dupliqués refusés ; topologie peer sans coordinateur acceptée", () => {
    expect(validateNetworkInvariants({ topology: "peer", members: [{ agentId: "a", role: "r" }, { agentId: "a", role: "r2" }] }).ok).toBe(false);
    expect(validateNetworkInvariants({ topology: "peer", members: [{ agentId: "a", role: "r" }, { agentId: "b", role: "r2" }] })).toEqual({ ok: true });
  });
});

describe("dépôt des réseaux", () => {
  it("création : membres validés réels+actifs, orgId validé AVANT écriture", async () => {
    docSet.mockResolvedValue(undefined);
    const created = await createNetwork("u1", {
      name: "Équipe Commerciale",
      topology: "coordinator",
      members: [
        { agentId: "a1", role: "Closer" },
        { agentId: "a2", role: "SDR" },
      ],
      coordinatorAgentId: "a1",
      orgId: "org-1",
    });
    expect(assertOrgAttachMock).toHaveBeenCalledWith("u1", "org-1");
    expect(getAgentForUserMock).toHaveBeenCalledTimes(2);
    expect(created.status).toBe("active");
    expect(created.members).toHaveLength(2);
  });

  it("création : agent membre inactif → refus (aucune écriture)", async () => {
    getAgentForUserMock.mockImplementation(async (_userId: string, agentId: string) => (agentId === "a2" ? { ...AGENT_RECORD(agentId), status: "paused" } : AGENT_RECORD(agentId)));
    await expect(
      createNetwork("u1", { name: "X", topology: "peer", members: [{ agentId: "a1", role: "r" }, { agentId: "a2", role: "r2" }] }),
    ).rejects.toThrow("inactif");
    expect(docSet).not.toHaveBeenCalled();
  });

  it("lecture : 404 anti-énumération hors propriétaire", async () => {
    docGet.mockResolvedValue({ exists: true, data: () => ({ ...networkDoc(), userId: "someone-else" }) });
    expect(await getNetwork("u1", "net-1")).toBeNull();
    docGet.mockResolvedValue({ exists: false, data: () => undefined });
    expect(await getNetwork("u1", "net-1")).toBeNull();
  });

  it("mise à jour : invariants re-validés (coordinateur hors membres → refus)", async () => {
    docGet.mockResolvedValue({ exists: true, data: () => networkDoc() });
    await expect(updateNetwork("u1", "net-1", { coordinatorAgentId: "a-zzz" })).rejects.toThrow("membre du réseau");
    expect(docUpdate).not.toHaveBeenCalled();
  });

  it("suppression : seule la LIAISON d'équipe disparaît", async () => {
    docGet.mockResolvedValue({ exists: true, data: () => networkDoc() });
    docDelete.mockResolvedValue(undefined);
    await deleteNetwork("u1", "net-1");
    expect(docDelete).toHaveBeenCalled();
  });

  it("liste : réseaux actifs par défaut, archives incluses sur demande", async () => {
    queryGet.mockResolvedValue({
      docs: [
        { data: () => networkDoc() },
        { data: () => networkDoc({ id: "net-arch", status: "archived" as const }) },
      ],
    });
    const active = await listNetworks("u1");
    expect(active).toHaveLength(1);
    const all = await listNetworks("u1", { includeArchived: true });
    expect(all).toHaveLength(2);
  });
});

describe("messagerie agent-à-agent", () => {
  it("canAgentsExchange : deux membres du même réseau seulement", () => {
    const network = { members: [{ agentId: "a" }, { agentId: "b" }] };
    expect(canAgentsExchange(network, "a", "b")).toBe(true);
    expect(canAgentsExchange(network, "a", "a")).toBe(false);
    expect(canAgentsExchange(network, "a", "zzz")).toBe(false);
  });

  it("envoi : émetteur et destinataire revérifiés membres du réseau", async () => {
    docGet.mockResolvedValue({ exists: true, data: () => networkDoc() });
    docSet.mockResolvedValue(undefined);
    const message = await sendAgentMessage({ userId: "u1", networkId: "net-1", fromAgentId: "a-coord", toAgentId: "a-redac", body: "Peux-tu relire la note ?" });
    expect(message.fromAgentId).toBe("a-coord");
    expect(message.toAgentId).toBe("a-redac");
    await expect(
      sendAgentMessage({ userId: "u1", networkId: "net-1", fromAgentId: "a-coord", toAgentId: "a-hors-réseau", body: "x" }),
    ).rejects.toThrow("membre du réseau");
    await expect(
      sendAgentMessage({ userId: "u1", networkId: "net-1", fromAgentId: "a-coord", toAgentId: "a-coord", body: "x" }),
    ).rejects.toThrow("lui-même");
  });

  it("auto-message interdit et corps vide interdit (aucune écriture)", async () => {
    docGet.mockResolvedValue({ exists: true, data: () => networkDoc() });
    await expect(sendAgentMessage({ userId: "u1", networkId: "net-1", fromAgentId: "a-coord", toAgentId: "a-redac", body: "   " })).rejects.toThrow("corps");
    expect(docSet).not.toHaveBeenCalled();
  });

  it("boîte de réception : filtrage unreadOnly", async () => {
    queryGet.mockResolvedValue({
      docs: [
        { data: () => ({ id: "m1", networkId: "net-1", fromAgentId: "a-redac", toAgentId: "a-coord", body: "x", createdAtMs: 2 }) },
        { data: () => ({ id: "m2", networkId: "net-1", fromAgentId: "a-redac", toAgentId: "a-coord", body: "y", createdAtMs: 1, readAtMs: 9 }) },
      ],
    });
    const all = await listAgentInbox("u1", { agentId: "a-coord" });
    expect(all).toHaveLength(2);
    const unread = await listAgentInbox("u1", { agentId: "a-coord", unreadOnly: true });
    expect(unread).toHaveLength(1);
    expect(unread[0].id).toBe("m1");
  });

  it("markRead : idempotent et propriétaire-scopé", async () => {
    docGet.mockResolvedValue({ exists: true, data: () => ({ userId: "u1", readAtMs: 5 }) });
    docUpdate.mockResolvedValue(undefined);
    await markMessageRead("u1", "m1");
    expect(docUpdate).not.toHaveBeenCalled(); // déjà lu
    docGet.mockResolvedValue({ exists: true, data: () => ({ userId: "u1" }) });
    await markMessageRead("u1", "m2");
    expect(docUpdate).toHaveBeenCalledWith({ readAtMs: expect.any(Number) });
    docGet.mockResolvedValue({ exists: true, data: () => ({ userId: "autre" }) });
    await expect(markMessageRead("u1", "m3")).rejects.toThrow("introuvable");
  });
});

describe("mission d'équipe (plan + runtime)", () => {
  it("topologie coordinator : coordinateur → membres (dépendants) → synthèse", () => {
    const plan = buildNetworkMissionPlan({ network: viewOf(networkDoc()), objective: "Lancer la campagne de printemps" });
    const coordinator = plan.steps.find((step) => step.id === "network-coordinator");
    expect(coordinator?.type).toBe("agent");
    expect(coordinator?.agentId).toBe("a-coord");
    expect(coordinator?.description).toContain("a-redac"); // composition relaya à l'exécution
    const member = plan.steps.find((step) => step.id === "network-member-a-redac");
    expect(member?.dependencies).toEqual(["network-coordinator"]);
    expect(member?.agentId).toBe("a-redac");
    expect(member?.sideEffect).toBe(false);
    const synthesis = plan.steps.find((step) => step.id === "network-synthesis");
    expect(synthesis?.dependencies).toContain("network-member-a-redac");
    expect(synthesis?.type).toBe("llm");
    // DAG connexe : toutes les étapes dépendent du coordinateur ou de la synthèse
    expect(plan.steps).toHaveLength(4);
  });

  it("topologie peer : membres en parallèle (aucune dépendance), synthèse dépend de tous", () => {
    const network = viewOf(networkDoc({ topology: "peer", coordinatorAgentId: undefined }));
    const plan = buildNetworkMissionPlan({ network, objective: "Audit du trimestre" });
    const members = plan.steps.filter((step) => step.id.startsWith("network-member-"));
    expect(members.every((step) => step.dependencies.length === 0)).toBe(true);
    expect(plan.steps.find((step) => step.id === "network-synthesis")?.dependencies).toHaveLength(members.length);
  });

  it("configuration runtime : liste blanche stricte = membres réels du réseau", () => {
    const config = networkRuntimeAgentConfig(viewOf(networkDoc()));
    expect(config.subAgentIds).toEqual(["a-coord", "a-redac"]);
    expect(config.systemPrompt).toContain("Équipe Marketing");
  });

  it("politique d'équipe : interne (pas de réseau ni fichier), messagerie d'équipe autorisée", () => {
    const policy = networkExecutionPolicy();
    expect(policy.allowNetwork).toBe(false);
    expect(policy.allowFileWrite).toBe(false);
    expect(policy.allowedTools).toContain("network.send_message");
    expect(policy.allowedTools).not.toContain("composio.execute");
  });
});
