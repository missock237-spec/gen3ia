import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DÉCLENCHEURS D'INGESTION (concept #9) : match pur, rendu de modèle borné,
 * CRUD propriétaire-scopé (agent cible validé), évaluation fail-soft —
 * mission enfilée via la file réelle quand configurée, journal par
 * document, échecs isolés sans jamais invalider l'ingestion.
 */

const docSet = vi.fn();
const docGet = vi.fn();
const docUpdate = vi.fn();
const docDelete = vi.fn();
const runsDocAdd = vi.fn();
const queryGet = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn((name: string) => ({
      doc: vi.fn(() => ({ set: docSet, get: docGet, update: docUpdate, delete: docDelete })),
      ...(name === "knowledgeTriggers" ? { where: vi.fn(() => ({ limit: vi.fn(() => ({ get: (...args: unknown[]) => queryGet(...args) })) })) } : {}),
      ...(name === "knowledgeTriggerRuns" ? { add: runsDocAdd } : {}),
    })),
  },
}));

const getAgentForUserMock = vi.fn();
vi.mock("@/lib/agents/repository", () => ({
  getAgentForUser: (...args: unknown[]) => getAgentForUserMock(...args),
}));

const createQueuedMissionMock = vi.fn();
const publishMissionTickMock = vi.fn();
const missionQueueConfiguredMock = vi.fn();
vi.mock("@/lib/queue/mission-queue", () => ({
  createQueuedMission: (...args: unknown[]) => createQueuedMissionMock(...args),
}));
vi.mock("@/lib/queue/qstash", () => ({
  missionQueueConfigured: () => missionQueueConfiguredMock(),
  publishMissionTick: (...args: unknown[]) => publishMissionTickMock(...args),
}));

const assertOrgAttachMock = vi.fn();
vi.mock("@/lib/tenants/resource-access", () => ({
  assertOrgAttach: (...args: unknown[]) => assertOrgAttachMock(...args),
}));

import {
  createKnowledgeTrigger,
  deleteKnowledgeTrigger,
  evaluateKnowledgeTriggers,
  listKnowledgeTriggers,
  renderTriggerObjective,
  triggerMatches,
  updateKnowledgeTrigger,
  type KnowledgeTriggerDoc,
} from "./triggers";

function triggerDoc(overrides: Partial<KnowledgeTriggerDoc> = {}): KnowledgeTriggerDoc {
  return {
    id: "t1",
    userId: "u1",
    name: "Factures → mission",
    match: { kind: "filename_contains", pattern: "facture" },
    action: { type: "run_agent_mission", agentId: "a-compta", objectiveTemplate: "Traite le document « {{document.name}} » : {{document.excerpt}}" },
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

beforeEach(() => {
  docSet.mockReset();
  docGet.mockReset();
  docUpdate.mockReset();
  docDelete.mockReset();
  runsDocAdd.mockReset();
  queryGet.mockReset();
  createQueuedMissionMock.mockReset();
  publishMissionTickMock.mockReset();
  missionQueueConfiguredMock.mockReset();
  assertOrgAttachMock.mockReset();
  assertOrgAttachMock.mockResolvedValue({ orgId: "o1", role: "owner", plan: "pro" });
  getAgentForUserMock.mockImplementation(async (_u: string, agentId: string) => ({ id: agentId, status: "active", name: "Compta" }));
  runsDocAdd.mockResolvedValue(undefined);
  docSet.mockResolvedValue(undefined);
});

describe("match + rendu (purs)", () => {
  it("match par nom de fichier, type MIME, ou tout", () => {
    expect(triggerMatches({ match: { kind: "filename_contains", pattern: "FACTURE" } }, { name: "facture_avril.pdf", mimeType: "text/html" })).toBe(true);
    expect(triggerMatches({ match: { kind: "filename_contains", pattern: "facture" } }, { name: "photo.jpg", mimeType: "image/jpeg" })).toBe(false);
    expect(triggerMatches({ match: { kind: "mime_type", pattern: "image/" } }, { name: "x.png", mimeType: "image/png" })).toBe(true);
    expect(triggerMatches({ match: { kind: "mime_type", pattern: "audio/" } }, { name: "x.png", mimeType: "image/png" })).toBe(false);
    expect(triggerMatches({ match: { kind: "any" } }, { name: "n'importe quoi", mimeType: "audio/mpeg" })).toBe(true);
  });

  it("rendu d'objectif : jetons remplacés et bornés (jamais de prompt géant)", () => {
    const objective = renderTriggerObjective(
      "Document {{document.name}} ({{document.mimeType}}) : {{document.excerpt}}",
      { name: "scan".repeat(500), mimeType: "image/png", excerpt: "texte".repeat(500) },
    );
    expect(objective).toContain("image/png");
    expect(objective.length).toBeLessThan(1_200);
  });
});

describe("CRUD des déclencheurs", () => {
  it("création : agent cible validé (réel + actif), sinon refus sans écriture", async () => {
    await createKnowledgeTrigger("u1", {
      name: "Vocal → mission",
      match: { kind: "mime_type", pattern: "audio/" },
      action: { type: "run_agent_mission", agentId: "a1", objectiveTemplate: "Analyse l'audio : {{document.excerpt}}" },
    });
    expect(docSet).toHaveBeenCalled();

    getAgentForUserMock.mockResolvedValue(null);
    await expect(
      createKnowledgeTrigger("u1", {
        name: "X",
        match: { kind: "any" },
        action: { type: "run_agent_mission", agentId: "ghost", objectiveTemplate: "abc def" },
      }),
    ).rejects.toThrow("introuvable ou inactif");
    expect(docSet).toHaveBeenCalledTimes(1);
  });

  it("propriétaire-scopé : lecture/mise à jour/suppression refusées hors propriétaire", async () => {
    docGet.mockResolvedValue({ exists: true, data: () => ({ ...triggerDoc(), userId: "autre" }) });
    await expect(updateKnowledgeTrigger("u1", "t1", { enabled: false })).rejects.toThrow("introuvable");
    await expect(deleteKnowledgeTrigger("u1", "t1")).rejects.toThrow("introuvable");
    expect(docUpdate).not.toHaveBeenCalled();
    expect(docDelete).not.toHaveBeenCalled();
  });

  it("liste du propriétaire", async () => {
    queryGet.mockResolvedValue({ docs: [{ data: () => triggerDoc() }] });
    const triggers = await listKnowledgeTriggers("u1");
    expect(triggers).toHaveLength(1);
    expect(triggers[0].action.agentId).toBe("a-compta");
  });

  it("rattachement org validé (assertOrgAttach) à la création — membre OK, étranger refusé sans écriture", async () => {
    await createKnowledgeTrigger("u1", {
      name: "Org trigger",
      match: { kind: "any" },
      action: { type: "run_agent_mission", agentId: "a1", objectiveTemplate: "Analyse le document" },
      orgId: "org-1",
    });
    expect(assertOrgAttachMock).toHaveBeenCalledWith("u1", "org-1");
    expect(docSet).toHaveBeenCalledTimes(1);

    assertOrgAttachMock.mockRejectedValueOnce(new Error("Organisation introuvable ou accès refusé."));
    await expect(
      createKnowledgeTrigger("u1", {
        name: "X",
        match: { kind: "any" },
        action: { type: "run_agent_mission", agentId: "a1", objectiveTemplate: "abc def" },
        orgId: "org-etrangere",
      }),
    ).rejects.toThrow("introuvable ou accès refusé");
    expect(docSet).toHaveBeenCalledTimes(1); // pas d'écriture supplémentaire
  });
});

describe("évaluation après ingestion", () => {
  const DOCUMENT = { id: "doc-1", name: "facture_avril.png", mimeType: "image/png", excerpt: "Total 1 200 EUR" };

  it("mission enfilée réellement quand la file est configurée", async () => {
    queryGet.mockResolvedValue({ docs: [{ data: () => triggerDoc() }] });
    missionQueueConfiguredMock.mockReturnValue(true);
    createQueuedMissionMock.mockResolvedValue(undefined);
    publishMissionTickMock.mockResolvedValue({ messageId: "m1" });

    const results = await evaluateKnowledgeTriggers({ userId: "u1", document: DOCUMENT });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("mission_queued");
    expect(results[0].runId).toBeTruthy();
    const missionInput = createQueuedMissionMock.mock.calls[0][0];
    expect(missionInput.objective).toContain("facture_avril.png");
    expect(missionInput.objective).toContain("Total 1 200 EUR");
    expect(missionInput.plan.steps[0].type).toBe("llm");
    expect(runsDocAdd).toHaveBeenCalledWith(expect.objectContaining({ documentId: "doc-1", status: "mission_queued" }));
  });

  it("file non configurée → résultat honnête matched_no_queue (pas de mission fantôme)", async () => {
    queryGet.mockResolvedValue({ docs: [{ data: () => triggerDoc() }] });
    missionQueueConfiguredMock.mockReturnValue(false);
    const results = await evaluateKnowledgeTriggers({ userId: "u1", document: DOCUMENT });
    expect(results[0].status).toBe("matched_no_queue");
    expect(createQueuedMissionMock).not.toHaveBeenCalled();
  });

  it("échec d'un déclencheur isolé : les autres continuent, ingestion jamais invalidée", async () => {
    queryGet.mockResolvedValue({
      docs: [
        { data: () => triggerDoc({ id: "t-broken", name: "cassé", action: { type: "run_agent_mission", agentId: "ghost", objectiveTemplate: "abc" } }) },
        { data: () => triggerDoc({ id: "t-ok", name: "ok" }) },
      ],
    });
    missionQueueConfiguredMock.mockReturnValue(true);
    getAgentForUserMock.mockImplementation(async (_u: string, agentId: string) => (agentId === "ghost" ? null : { id: agentId, status: "active" }));
    createQueuedMissionMock.mockResolvedValue(undefined);
    publishMissionTickMock.mockResolvedValue(undefined);

    const results = await evaluateKnowledgeTriggers({ userId: "u1", document: DOCUMENT });
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("agent_missing");
    expect(results[1].status).toBe("mission_queued");
  });

  it("déclencheur non-matching : aucun travail, aucune écriture", async () => {
    queryGet.mockResolvedValue({ docs: [{ data: () => triggerDoc() }] });
    const results = await evaluateKnowledgeTriggers({ userId: "u1", document: { id: "d", name: "photo-vacances.jpg", mimeType: "image/png", excerpt: "" } });
    expect(results).toHaveLength(0);
    expect(createQueuedMissionMock).not.toHaveBeenCalled();
    expect(runsDocAdd).not.toHaveBeenCalled();
  });

  it("mission org-rattacée : l'orgId du DÉCLENCHEUR prime sur celui de l'ingestion", async () => {
    queryGet.mockResolvedValue({ docs: [{ data: () => triggerDoc({ orgId: "org-trigger" }) }] });
    missionQueueConfiguredMock.mockReturnValue(true);
    createQueuedMissionMock.mockResolvedValue(undefined);
    publishMissionTickMock.mockResolvedValue(undefined);

    await evaluateKnowledgeTriggers({ userId: "u1", orgId: "org-ingestion", document: DOCUMENT });
    expect(createQueuedMissionMock.mock.calls[0][0].orgId).toBe("org-trigger");
    expect(runsDocAdd).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-trigger" }));
  });
});
