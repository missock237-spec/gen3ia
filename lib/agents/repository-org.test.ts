import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Dépôt agents org-aware (recommandation C) — ère R2 (Task 109) : création
 * avec rattachement validé AVANT écriture, lecture/écriture/suppression via
 * la politique centralisée (lib/tenants/resource-access), liste union
 * personnel + organisations (dédupliquée, triée, plafonnée).
 *
 * Backend simulé : R2 EN MÉMOIRE (Map clé → Buffer) sur lequel tourne le
 * VRAI user-data-store (fondation 109-a) — mêmes clés canoniques que la
 * production (`users/{uid}/agents/{id}.json`, pointeurs
 * `orgs/{orgId}/agents/{id}.json`, index global `agents-index/{id}.json`).
 * Les variantes *ForOwner restent inchangées pour les chemins runtime internes.
 */

// ---------------------------------------------------------------------------
// État hoisted — R2 factice (Map clé → Buffer)
// ---------------------------------------------------------------------------

const r2State = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
  uploads: [] as string[],
  deletes: [] as string[],
  /** Préfixes demandés au listage (trace des scans). */
  listCalls: [] as string[],
}));

vi.mock("@/lib/storage/r2", () => {
  function notFound(key: string): Error {
    // Forme réelle du SDK S3 v3 : name = "NoSuchKey" (+ metadata 404).
    const error = new Error(`The specified key does not exist. (${key})`);
    error.name = "NoSuchKey";
    (error as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 404 };
    return error;
  }
  return {
    putObject: async (options: { key: string; body: Uint8Array | Buffer }) => {
      r2State.store.set(options.key, Buffer.from(options.body));
      r2State.uploads.push(options.key);
    },
    uploadToR2: async (key: string, body: Uint8Array | Buffer) => {
      r2State.store.set(key, Buffer.from(body));
      r2State.uploads.push(key);
    },
    downloadFromR2: async (key: string, maxBytes?: number) => {
      const body = r2State.store.get(key);
      if (!body) throw notFound(key);
      if (typeof maxBytes === "number" && body.byteLength > maxBytes) {
        throw new Error("R2 object exceeds configured read limit");
      }
      return body;
    },
    deleteFromR2: async (key: string) => {
      r2State.deletes.push(key);
      r2State.store.delete(key);
    },
    deleteObject: async (key: string) => {
      r2State.deletes.push(key);
      r2State.store.delete(key);
    },
    listObjectsUnderPrefix: async (prefix: string, maxResults?: number) => {
      r2State.listCalls.push(prefix);
      const keys = [...r2State.store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const borne = typeof maxResults === "number" ? keys.slice(0, maxResults) : keys;
      return borne.map((key) => ({
        key,
        sizeBytes: r2State.store.get(key)?.byteLength ?? 0,
        updatedAt: new Date(0).toISOString(),
      }));
    },
  };
});

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

import { readJsonIfExists, writeJson } from "@/lib/storage/user-data-store";

import {
  createAgentRecord,
  deleteAgentForUser,
  getAgentForUser,
  listAgentsForUser,
  updateAgentForUser,
} from "./repository";

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

/** Sème un agent chez son propriétaire + index global (+ pointeur org). */
async function seedAgent(ownerId: string, agentId: string, overrides: Partial<Record<string, unknown>> = {}) {
  const doc = {
    v: 1, id: agentId, ...baseAgent({ ownerId, ...overrides }),
    createdAt: typeof overrides.createdAt === "string"
      ? overrides.createdAt
      : new Date(2026, 0, 1).toISOString(),
    updatedAt: new Date(2026, 0, 1).toISOString(),
  };
  await writeJson(`users/${ownerId}/agents/${agentId}.json`, doc);
  await writeJson(`agents-index/${agentId}.json`, { v: 1, ownerId, agentId });
  const orgId = overrides.orgId;
  if (typeof orgId === "string" && orgId) {
    await writeJson(`orgs/${orgId}/agents/${agentId}.json`, { v: 1, ownerId, agentId });
  }
  return doc;
}

/** Lit le document agent stocké chez son propriétaire. */
async function storedDoc(ownerId: string, agentId: string): Promise<Record<string, unknown> | null> {
  return readJsonIfExists(`users/${ownerId}/agents/${agentId}.json`);
}

/** Premier id d'agent trouvé chez un propriétaire (création ULID). */
function firstAgentId(ownerId: string): string {
  const prefix = `users/${ownerId}/agents/`;
  const key = [...r2State.store.keys()].find((k) => k.startsWith(prefix));
  if (!key) throw new Error("Aucun agent créé chez " + ownerId);
  return key.slice(prefix.length, -".json".length);
}

beforeEach(() => {
  r2State.store.clear();
  r2State.uploads.length = 0;
  r2State.deletes.length = 0;
  r2State.listCalls.length = 0;
  mockedAssertRead.mockReset(); mockedAssertWrite.mockReset();
  mockedAssertAttach.mockReset(); mockedAssertTransfer.mockReset(); mockedListOrgs.mockReset();
  mockedAssertRead.mockResolvedValue({ read: true, write: true, via: "owner" });
  mockedAssertWrite.mockResolvedValue({ read: true, write: true, via: "owner" });
  mockedListOrgs.mockResolvedValue([]);
});

describe("createAgentRecord — rattachement organisationnel", () => {
  it("sans orgId : aucun appel d'attachement (comportement historique)", async () => {
    await createAgentRecord("u1", baseAgent());
    expect(mockedAssertAttach).not.toHaveBeenCalled();
    const written = await storedDoc("u1", firstAgentId("u1"));
    expect(written?.ownerId).toBe("u1");
    expect(written?.orgId).toBeUndefined();
  });

  it("avec orgId : l'attachement est validé AVANT l'écriture", async () => {
    await createAgentRecord("u1", baseAgent(), { orgId: "org-1" });
    expect(mockedAssertAttach).toHaveBeenCalledWith("u1", "org-1");
    const id = firstAgentId("u1");
    const written = await storedDoc("u1", id);
    expect(written?.orgId).toBe("org-1");
    // Pointeur org écrit en même temps que l'agent.
    await expect(readJsonIfExists(`orgs/org-1/agents/${id}.json`)).resolves.toMatchObject({ ownerId: "u1", agentId: id });
  });

  it("attach refusé : l'écriture n'a JAMAIS lieu", async () => {
    mockedAssertAttach.mockRejectedValue(new Error("Organisation introuvable ou accès refusé."));
    await expect(createAgentRecord("u1", baseAgent(), { orgId: "org-x" })).rejects.toThrow("Organisation introuvable");
    expect(r2State.uploads).toHaveLength(0);
    expect(r2State.store.size).toBe(0);
  });

  it("orgId blanc dans les options : traité comme absent", async () => {
    await createAgentRecord("u1", baseAgent(), { orgId: "   " });
    expect(mockedAssertAttach).not.toHaveBeenCalled();
    const written = await storedDoc("u1", firstAgentId("u1"));
    expect(written?.orgId).toBeUndefined();
  });
});

describe("getAgentForUser — lecture org-aware", () => {
  it("lecture autorisée → enregistrement mappé", async () => {
    await seedAgent("u1", "a1");
    const agent = await getAgentForUser("u2", "a1");
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("Agent Org");
    expect(mockedAssertRead).toHaveBeenCalledWith("u2", { ownerId: "u1", orgId: null });
  });

  it("lecture refusée → null (indiscernable d'un agent absent)", async () => {
    await seedAgent("u1", "a1");
    mockedAssertRead.mockRejectedValue(new Error("Ressource introuvable ou accès refusé."));
    expect(await getAgentForUser("u2", "a1")).toBeNull();
  });

  it("agent inexistant → null sans appel de politique", async () => {
    expect(await getAgentForUser("u2", "a1")).toBeNull();
    expect(mockedAssertRead).not.toHaveBeenCalled();
  });
});

describe("updateAgentForUser — écriture et transfert", () => {
  it("écriture autorisée : le patch fusionne, ownerId préservé depuis le doc", async () => {
    await seedAgent("u1", "a1", { orgId: "org-1" });
    const updated = await updateAgentForUser("u2", "a1", { name: "Renommé" });
    expect(mockedAssertWrite).toHaveBeenCalledWith("u2", { ownerId: "u1", orgId: "org-1" });
    expect(updated).not.toBeNull();
    const written = await storedDoc("u1", "a1");
    expect(written?.name).toBe("Renommé");
    expect(written?.ownerId).toBe("u1");
  });

  it("écriture refusée (membre lecture seule) → null sans écriture", async () => {
    await seedAgent("u1", "a1", { orgId: "org-1" });
    mockedAssertWrite.mockRejectedValue(new Error("Action réservée au propriétaire ou aux administrateurs."));
    expect(await updateAgentForUser("u2", "a1", { name: "X" })).toBeNull();
    const written = await storedDoc("u1", "a1");
    expect(written?.name).toBe("Agent Org");
  });

  it("transfert org : patch.orgId défini → assertOrgTransfer avec la destination", async () => {
    await seedAgent("u1", "a1");
    await updateAgentForUser("u2", "a1", { orgId: "org-9" });
    expect(mockedAssertTransfer).toHaveBeenCalledWith("u2", { ownerId: "u1", orgId: null }, "org-9");
    const written = await storedDoc("u1", "a1");
    expect(written?.orgId).toBe("org-9");
    // Réindexation : l'ancien pointeur (aucun ici) n'existe pas, le nouveau si.
    await expect(readJsonIfExists("orgs/org-9/agents/a1.json")).resolves.toMatchObject({ ownerId: "u1", agentId: "a1" });
  });

  it("détachement : patch.orgId=\"\" → sémantique merge Firestore conservée (orgId inchangé, undefined ignoré)", async () => {
    // Historique exact : set(merge) + ignoreUndefinedProperties — un champ
    // fourni à undefined NE ÉCRASE PAS la valeur stockée. Le rattachement
    // courant est donc conservé, comme avant la migration R2.
    await seedAgent("u1", "a1", { orgId: "org-1" });
    await updateAgentForUser("u2", "a1", { orgId: "" });
    const written = await storedDoc("u1", "a1");
    expect(written?.orgId).toBe("org-1");
    await expect(readJsonIfExists("orgs/org-1/agents/a1.json")).resolves.toMatchObject({ ownerId: "u1" });
  });

  it("sans patch.orgId : l'orgId courant est conservé tel quel", async () => {
    await seedAgent("u1", "a1", { orgId: "org-1" });
    await updateAgentForUser("u2", "a1", { name: "Nouveau nom" });
    const written = await storedDoc("u1", "a1");
    expect(written?.orgId).toBe("org-1");
    expect(mockedAssertTransfer).toHaveBeenCalledWith("u2", { ownerId: "u1", orgId: "org-1" }, undefined);
  });
});

describe("deleteAgentForUser — suppression org-aware", () => {
  it("écriture autorisée → suppression effective, true", async () => {
    await seedAgent("u1", "a1", { orgId: "org-1" });
    expect(await deleteAgentForUser("u2", "a1")).toBe(true);
    expect(await storedDoc("u1", "a1")).toBeNull();
    // Pointeur org ET index global nettoyés.
    expect(await readJsonIfExists("orgs/org-1/agents/a1.json")).toBeNull();
    expect(await readJsonIfExists("agents-index/a1.json")).toBeNull();
  });

  it("écriture refusée → false sans suppression", async () => {
    await seedAgent("u1", "a1", { orgId: "org-1" });
    mockedAssertWrite.mockRejectedValue(new Error("Action réservée."));
    expect(await deleteAgentForUser("u2", "a1")).toBe(false);
    expect(await storedDoc("u1", "a1")).not.toBeNull();
  });
});

describe("listAgentsForUser — liste union", () => {
  it("sans organisation : agents personnels uniquement (aucun scan d'org)", async () => {
    await seedAgent("u1", "a1");
    mockedListOrgs.mockResolvedValue([]);
    const agents = await listAgentsForUser("u1");
    expect(agents.map((a) => a.id)).toEqual(["a1"]);
    expect(r2State.listCalls.filter((p) => p.startsWith("orgs/"))).toHaveLength(0);
  });

  it("union personnel + org, dédupliquée et triée createdAt desc", async () => {
    await seedAgent("u1", "perso");
    // Pointeur org qui pointe vers l'agent personnel lui-même : dédup par id.
    await writeJson("orgs/org-1/agents/perso.json", { v: 1, ownerId: "u1", agentId: "perso" });
    // Agent d'un autre propriétaire, partagé via l'org.
    await seedAgent("u9", "orgdoc", { orgId: "org-1" });
    mockedListOrgs.mockResolvedValue(["org-1"]);
    const agents = await listAgentsForUser("u1");
    expect(agents.map((a) => a.id).sort()).toEqual(["orgdoc", "perso"]);
    expect(agents).toHaveLength(2);
  });

  it("filtrage : archivés exclus, projectId respecté sur les agents d'org", async () => {
    await seedAgent("u9", "arch", { orgId: "org-1", status: "archived" });
    await seedAgent("u9", "wrong-project", { orgId: "org-1", projectId: "p2" });
    await seedAgent("u9", "good", { orgId: "org-1", projectId: "p1" });
    mockedListOrgs.mockResolvedValue(["org-1"]);
    const agents = await listAgentsForUser("u1", "p1");
    expect(agents.map((a) => a.id)).toEqual(["good"]);
  });

  it("plus de chunking : les 65 orgs sont toutes parcourues (plus d'opérateur in Firestore)", async () => {
    mockedListOrgs.mockResolvedValue(Array.from({ length: 65 }, (_, i) => `org-${i}`));
    // Un agent rangé dans la DERNIÈRE org : il doit être trouvé malgré la
    // position (l'ère Firestore tronquait par chunks de 30 via `in`).
    await seedAgent("u9", "loin", { orgId: "org-64" });
    const agents = await listAgentsForUser("u1");
    expect(agents.map((a) => a.id)).toContain("loin");
    expect(r2State.listCalls).toContain("orgs/org-64/agents");
  });

  it("plafond global 100 agents (les plus récents d'abord)", async () => {
    const many = Array.from({ length: 140 }, (_, i) => ({
      ownerId: "u9",
      agentId: `org-${i}`,
      createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    }));
    for (const item of many) {
      await seedAgent(item.ownerId, item.agentId, { orgId: "org-1", createdAt: item.createdAt });
    }
    mockedListOrgs.mockResolvedValue(["org-1"]);
    const agents = await listAgentsForUser("u1");
    expect(agents).toHaveLength(100);
    // Le plus récent (org-139) arrive en tête.
    expect(agents[0].id).toBe("org-139");
  });
});
