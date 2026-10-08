import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 109-d — dépôt agents sur backend Cloudflare R2.
 *
 * Mock R2 EN MÉMOIRE (Map clé → Buffer) — même approche que
 * lib/identity/r2-identity-store.test.ts / workspace-durability.test.ts :
 * le VRAI user-data-store (fondation 109-a) est exercé contre un R2 simulé
 * fidèle (NoSuchKey pour clé absente, listage par préfixe, plafonds).
 * La politique d'accès multi-tenant (lib/tenants/resource-access) reste
 * mockée : le dépôt est testé isolément de Firestore.
 */

// ---------------------------------------------------------------------------
// État hoisted — R2 factice (Map clé → Buffer)
// ---------------------------------------------------------------------------

const r2State = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
  uploads: [] as string[],
  deletes: [] as string[],
  failUpload: false,
  failDownload: false,
  failDelete: false,
  /** Quand défini, le listage échoue UNIQUEMENT sous ce préfixe. */
  failListPrefix: null as string | null,
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
      if (r2State.failUpload) throw new Error("R2 upload impossible (mock)");
      r2State.store.set(options.key, Buffer.from(options.body));
      r2State.uploads.push(options.key);
    },
    uploadToR2: async (key: string, body: Uint8Array | Buffer) => {
      if (r2State.failUpload) throw new Error("R2 upload impossible (mock)");
      r2State.store.set(key, Buffer.from(body));
      r2State.uploads.push(key);
    },
    downloadFromR2: async (key: string, maxBytes?: number) => {
      if (r2State.failDownload) throw new Error("R2 lecture impossible (mock)");
      const body = r2State.store.get(key);
      if (!body) throw notFound(key);
      if (typeof maxBytes === "number" && body.byteLength > maxBytes) {
        throw new Error("R2 object exceeds configured read limit");
      }
      return body;
    },
    deleteFromR2: async (key: string) => {
      if (r2State.failDelete) throw new Error("R2 suppression impossible (mock)");
      r2State.deletes.push(key);
      r2State.store.delete(key);
    },
    deleteObject: async (key: string) => {
      if (r2State.failDelete) throw new Error("R2 suppression impossible (mock)");
      r2State.deletes.push(key);
      r2State.store.delete(key);
    },
    listObjectsUnderPrefix: async (prefix: string, maxResults?: number) => {
      if (r2State.failListPrefix && prefix.startsWith(r2State.failListPrefix)) {
        throw new Error("R2 listage impossible (mock)");
      }
      return [...r2State.store.keys()]
        .filter((key) => key.startsWith(prefix))
        .slice(0, maxResults ?? 500)
        .map((key) => ({ key, sizeBytes: r2State.store.get(key)!.length, updatedAt: "" }));
    },
  };
});

// ---------------------------------------------------------------------------
// Mock de la politique d'accès multi-tenant (dépôt = appelant isolé)
// ---------------------------------------------------------------------------

const accessState = vi.hoisted(() => ({
  listUserOrgIds: vi.fn<(uid: string) => Promise<string[]>>(),
  assertResourceRead: vi.fn<(uid: string, ref: { ownerId: string; orgId?: string | null }) => Promise<unknown>>(),
  assertResourceWrite: vi.fn<(uid: string, ref: { ownerId: string; orgId?: string | null }) => Promise<unknown>>(),
  assertOrgAttach: vi.fn<(uid: string, orgId: string) => Promise<unknown>>(),
  assertOrgTransfer: vi.fn<(uid: string, ref: { ownerId: string; orgId?: string | null }, target?: string) => Promise<void>>(),
}));

vi.mock("@/lib/tenants/resource-access", () => ({
  assertOrgAttach: accessState.assertOrgAttach,
  assertOrgTransfer: accessState.assertOrgTransfer,
  assertResourceWrite: accessState.assertResourceWrite,
  assertResourceRead: accessState.assertResourceRead,
  listUserOrgIds: accessState.listUserOrgIds,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import {
  countActiveAgentsOfType,
  createAgentRecord,
  deleteAgentForOwner,
  deleteAgentForUser,
  getAgentById,
  getAgentForOwner,
  getAgentForUser,
  listAgentsByOwner,
  listAgentsForUser,
  updateAgentForOwner,
  updateAgentForUser,
} from "./repository";

const validInput = {
  name: "Agent Test",
  description: "Agent de test R2",
  type: "universal" as const,
  skills: ["Analyse"],
  systemPrompt: "Agent Gen3ia de test avec un prompt suffisamment long.",
};

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function readDoc(key: string): Record<string, unknown> {
  const body = r2State.store.get(key);
  expect(body, `clé attendue dans R2 : ${key}`).toBeDefined();
  return JSON.parse(body!.toString("utf8")) as Record<string, unknown>;
}

/** Sème un document agent directement dans le R2 factice. */
function seedAgent(ownerId: string, agentId: string, fields: Record<string, unknown> = {}): void {
  const doc = {
    v: 1,
    id: agentId,
    ownerId,
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...fields,
  };
  r2State.store.set(`users/${ownerId}/agents/${agentId}.json`, Buffer.from(JSON.stringify(doc)));
}

/** Sème un pointeur d'org (index orgs/{orgId}/agents/). */
function seedPointer(orgId: string, ownerId: string, agentId: string): void {
  r2State.store.set(`orgs/${orgId}/agents/${agentId}.json`, Buffer.from(JSON.stringify({ v: 1, ownerId, agentId })));
}

/** Sème l'index global léger (agents-index/{agentId}.json). */
function seedGlobalIndex(agentId: string, ownerId: string): void {
  r2State.store.set(`agents-index/${agentId}.json`, Buffer.from(JSON.stringify({ v: 1, ownerId, agentId })));
}

function resetAll(): void {
  r2State.store.clear();
  r2State.uploads.length = 0;
  r2State.deletes.length = 0;
  r2State.failUpload = false;
  r2State.failDownload = false;
  r2State.failDelete = false;
  r2State.failListPrefix = null;
  accessState.listUserOrgIds.mockReset();
  accessState.assertResourceRead.mockReset();
  accessState.assertResourceWrite.mockReset();
  accessState.assertOrgAttach.mockReset();
  accessState.assertOrgTransfer.mockReset();
  // Défauts : sémantique de la vraie politique (owner d'abord, org ensuite).
  accessState.assertResourceRead.mockImplementation(async (uid, ref) => {
    if (ref.ownerId === uid) return { read: true, write: true, via: "owner" };
    throw new Error("Ressource introuvable ou accès refusé.");
  });
  accessState.assertResourceWrite.mockImplementation(async (uid, ref) => {
    if (ref.ownerId === uid) return { read: true, write: true, via: "owner" };
    throw new Error("Action réservée au propriétaire ou aux administrateurs.");
  });
  accessState.assertOrgAttach.mockResolvedValue(undefined);
  accessState.assertOrgTransfer.mockResolvedValue(undefined);
  accessState.listUserOrgIds.mockResolvedValue([]);
}

beforeEach(() => {
  resetAll();
});

// ---------------------------------------------------------------------------
// createAgentRecord
// ---------------------------------------------------------------------------

describe("createAgentRecord (backend R2)", () => {
  it("nominal : agent écrit chez son propriétaire + index global, id ULID, horodatages ISO", async () => {
    const record = await createAgentRecord("user-1", validInput);
    expect(record.id).toMatch(ULID_RE);
    expect(record.ownerId).toBe("user-1");
    expect(Number.isNaN(Date.parse(record.createdAt))).toBe(false);

    const doc = readDoc(`users/user-1/agents/${record.id}.json`);
    expect(doc.v).toBe(1);
    expect(doc.id).toBe(record.id);
    expect(doc.ownerId).toBe("user-1");
    expect(doc.name).toBe("Agent Test");
    expect(typeof doc.createdAt).toBe("string");

    const index = readDoc(`agents-index/${record.id}.json`);
    expect(index).toMatchObject({ ownerId: "user-1", agentId: record.id });
  });

  it("avec orgId : garde d'attachement AVANT toute écriture + pointeur org écrit", async () => {
    const record = await createAgentRecord("user-1", validInput, { orgId: "org-1" });
    expect(accessState.assertOrgAttach).toHaveBeenCalledWith("user-1", "org-1");
    expect(record.orgId).toBe("org-1");
    const pointer = readDoc(`orgs/org-1/agents/${record.id}.json`);
    expect(pointer).toMatchObject({ ownerId: "user-1", agentId: record.id });
  });

  it("org refusée (assertOrgAttach) : l'erreur est rejetée, AUCUNE écriture R2", async () => {
    accessState.assertOrgAttach.mockRejectedValue(new Error("Organisation introuvable ou accès refusé."));
    await expect(createAgentRecord("user-1", validInput, { orgId: "org-x" })).rejects.toThrow(/Organisation introuvable/);
    expect(r2State.store.size).toBe(0);
  });

  it("sans prompt saisi : la charte professionnelle est générée", async () => {
    const record = await createAgentRecord("user-1", { name: "Agent Charte", type: "universal", skills: ["Analyse"] });
    expect(record.systemPrompt).toBeTruthy();
    expect(record.systemPrompt!.length).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// listAgentsByOwner / listAgentsForUser
// ---------------------------------------------------------------------------

describe("listAgentsByOwner (scan préfixe R2)", () => {
  it("filtres archived/projet + tri createdAt desc", async () => {
    seedAgent("user-1", "a-vieux", { name: "Vieux", createdAt: new Date("2026-01-01T00:00:00Z").toISOString() });
    seedAgent("user-1", "a-archive", { name: "Archivé", status: "archived", createdAt: new Date("2026-01-04T00:00:00Z").toISOString() });
    seedAgent("user-1", "a-recent", { name: "Récent", createdAt: new Date("2026-01-03T00:00:00Z").toISOString() });
    seedAgent("user-2", "a-autre", { name: "Autre", createdAt: new Date("2026-01-05T00:00:00Z").toISOString() });

    const list = await listAgentsByOwner("user-1");
    expect(list.map((a) => a.name)).toEqual(["Récent", "Vieux"]);

    const projet = await listAgentsByOwner("user-1", "proj-1");
    expect(projet.map((a) => a.id)).toEqual([]); // aucun agent de user-1 n'a ce projet
  });

  it("R2 indisponible : l'erreur est propagée (pas de repli silencieux)", async () => {
    r2State.failListPrefix = "users/";
    // La fondation 109-a enveloppe la panne brute en UserDataError("unavailable")
    // — le message classifié remonte tel quel, AUCUN repli silencieux.
    const error = await listAgentsByOwner("user-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe("unavailable");
    expect((error as Error).message).toMatch(/indisponible au listage/);
  });

  it("plus de 100 agents actifs : slice mémoire à 100, les plus récents d'abord", async () => {
    for (let i = 0; i < 120; i += 1) {
      seedAgent("user-1", `a-${String(i).padStart(3, "0")}`, {
        name: `Agent ${i + 1}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      });
    }
    const list = await listAgentsByOwner("user-1");
    expect(list).toHaveLength(100);
    expect(list[0]!.name).toBe("Agent 120");
  });
});

describe("listAgentsForUser (union propre + org, dédupliquée)", () => {
  it("sans org : agents personnels uniquement", async () => {
    seedAgent("user-1", "p1", { name: "Perso" });
    const list = await listAgentsForUser("user-1");
    expect(list.map((a) => a.id)).toEqual(["p1"]);
  });

  it("orgs : agents d'org lus chez leur propriétaire, dédupliqués, triés createdAt desc", async () => {
    seedAgent("user-1", "p1", { name: "Perso", createdAt: new Date("2026-01-01T00:00:00Z").toISOString() });
    seedAgent("user-2", "o1", { name: "Org Récent", createdAt: new Date("2026-01-03T00:00:00Z").toISOString() });
    seedAgent("user-2", "o2", { name: "Org Archivé", status: "archived", createdAt: new Date("2026-01-04T00:00:00Z").toISOString() });
    seedPointer("org-1", "user-2", "o1");
    seedPointer("org-1", "user-2", "o2");
    seedPointer("org-1", "user-2", "orphelin"); // pointeur orphelin : agent supprimé
    seedPointer("org-1", "user-1", "p1"); // déjà personnel : dédupliqué par id
    accessState.listUserOrgIds.mockResolvedValue(["org-1"]);

    const list = await listAgentsForUser("user-1");
    expect(list.map((a) => a.name)).toEqual(["Org Récent", "Perso"]);
    expect(list).toHaveLength(2);
  });

  it("filtre projectId appliqué aux agents d'org comme aux personnels", async () => {
    seedAgent("user-1", "p1", { name: "Perso Projet", projectId: "proj-1" });
    seedAgent("user-2", "o1", { name: "Org Projet", projectId: "proj-1" });
    seedAgent("user-2", "o2", { name: "Org Autre Projet", projectId: "proj-2" });
    seedPointer("org-1", "user-2", "o1");
    seedPointer("org-1", "user-2", "o2");
    accessState.listUserOrgIds.mockResolvedValue(["org-1"]);

    const list = await listAgentsForUser("user-1", "proj-1");
    expect(list.map((a) => a.name).sort()).toEqual(["Org Projet", "Perso Projet"]);
  });

  it("listUserOrgIds en échec → repli fail-soft sur les agents personnels (pas de 500)", async () => {
    accessState.listUserOrgIds.mockRejectedValue(new Error("index d'appartenance injoignable"));
    seedAgent("user-1", "p1", { name: "Perso" });
    const list = await listAgentsForUser("user-1");
    expect(list.map((a) => a.name)).toEqual(["Perso"]);
  });

  it("listage du préfixe org en échec → repli fail-soft sur les agents personnels", async () => {
    seedAgent("user-1", "p1", { name: "Perso" });
    seedPointer("org-1", "user-2", "o1");
    accessState.listUserOrgIds.mockResolvedValue(["org-1"]);
    r2State.failListPrefix = "orgs/";
    const list = await listAgentsForUser("user-1");
    expect(list.map((a) => a.name)).toEqual(["Perso"]);
  });
});

// ---------------------------------------------------------------------------
// getAgentById / getAgentForOwner / getAgentForUser
// ---------------------------------------------------------------------------

describe("lectures unitaires (ownership fail-closed)", () => {
  it("getAgentById : résolu via l'index global — actif lu, non actif → null, inconnu → null", async () => {
    seedAgent("user-1", "a1", { name: "Actif" });
    seedGlobalIndex("a1", "user-1");
    seedAgent("user-1", "a2", { name: "Archivé", status: "archived" });
    seedGlobalIndex("a2", "user-1");

    expect((await getAgentById("a1"))?.name).toBe("Actif");
    expect(await getAgentById("a2")).toBeNull();
    expect(await getAgentById("inconnu")).toBeNull();
  });

  it("getAgentForOwner : garde d'ownership par préfixe utilisateur", async () => {
    seedAgent("user-2", "a1", { name: "Privé" });
    const r = await getAgentForOwner("user-2", "a1");
    expect(r?.name).toBe("Privé");
    expect(await getAgentForOwner("user-1", "a1")).toBeNull();
  });

  it("getAgentForUser : assertResourceRead consulté — dénégation → null (fail-closed)", async () => {
    seedAgent("user-2", "a1", { name: "Privé" });
    seedGlobalIndex("a1", "user-2");
    const record = await getAgentForUser("user-3", "a1");
    expect(record).toBeNull();
    expect(accessState.assertResourceRead).toHaveBeenCalledWith("user-3", { ownerId: "user-2", orgId: null });
  });

  it("getAgentForUser : ressource d'org lisible par un membre (orgId transmis à la politique)", async () => {
    seedAgent("user-2", "a1", { name: "Org", orgId: "org-1" });
    seedGlobalIndex("a1", "user-2");
    accessState.assertResourceRead.mockResolvedValue({ read: true, write: false, via: "org-member" });
    const record = await getAgentForUser("user-3", "a1");
    expect(record?.name).toBe("Org");
    expect(accessState.assertResourceRead).toHaveBeenCalledWith("user-3", { ownerId: "user-2", orgId: "org-1" });
  });
});

// ---------------------------------------------------------------------------
// updateAgentForOwner / updateAgentForUser
// ---------------------------------------------------------------------------

describe("updateAgentForOwner", () => {
  it("patch appliqué, champs non fournis préservés (sémantique merge + ignoreUndefined)", async () => {
    const persona = { tone: "direct", verbosity: "concis", humor: "aucun", language: "Français", constraints: [], capabilities: { webSearch: true, codeExecution: true, dataAnalysis: true, fileGeneration: true } };
    seedAgent("user-1", "a1", {
      name: "Avant",
      persona,
      createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    });
    const updated = await updateAgentForOwner("user-1", "a1", { name: "Nouveau Nom" });
    expect(updated?.name).toBe("Nouveau Nom");
    expect(updated?.persona).toEqual(persona); // non fourni → préservé
    expect(updated?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(await updateAgentForOwner("user-1", "inconnu", { name: "X" })).toBeNull();
  });
});

describe("updateAgentForUser (org-aware + réindexation des pointeurs)", () => {
  it("transfert d'org : doc.orgId mis à jour, ancien pointeur retiré, nouveau écrit", async () => {
    seedAgent("user-2", "a1", { name: "Mobile", orgId: "org-1" });
    seedPointer("org-1", "user-2", "a1");
    seedGlobalIndex("a1", "user-2");

    const updated = await updateAgentForUser("user-2", "a1", { orgId: "org-2" });
    expect(updated?.orgId).toBe("org-2");
    expect(accessState.assertOrgTransfer).toHaveBeenCalled();
    expect(r2State.store.has("orgs/org-1/agents/a1.json")).toBe(false);
    expect(readDoc("orgs/org-2/agents/a1.json")).toMatchObject({ ownerId: "user-2", agentId: "a1" });

    // Le listing via l'ANCIENNE org ne retrouve plus l'agent (pointeur retiré).
    accessState.listUserOrgIds.mockResolvedValue(["org-1"]);
    expect(await listAgentsForUser("user-1")).toEqual([]);
  });

  it("patch classique : nom changé, persona préservé, renvoyé via getAgentForUser", async () => {
    seedAgent("user-2", "a1", { name: "Avant", persona: { tone: "direct" } });
    seedGlobalIndex("a1", "user-2");
    const updated = await updateAgentForUser("user-2", "a1", { name: "Après" });
    expect(updated?.name).toBe("Après");
    expect(updated?.persona).toMatchObject({ tone: "direct" });
  });

  it("membre sans droit d'écriture : null, document et pointeurs intacts", async () => {
    seedAgent("user-2", "a1", { name: "Avant", orgId: "org-1" });
    seedPointer("org-1", "user-2", "a1");
    seedGlobalIndex("a1", "user-2");
    accessState.assertResourceWrite.mockRejectedValue(new Error("Action réservée au propriétaire ou aux administrateurs."));
    expect(await updateAgentForUser("user-3", "a1", { name: "Piraté" })).toBeNull();
    expect(readDoc("users/user-2/agents/a1.json")).toMatchObject({ name: "Avant" });
    expect(r2State.store.has("orgs/org-1/agents/a1.json")).toBe(true);
  });

  it("agent inconnu → null", async () => {
    expect(await updateAgentForUser("user-1", "inconnu", { name: "X" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteAgentForOwner / deleteAgentForUser
// ---------------------------------------------------------------------------

describe("suppression + nettoyage des index", () => {
  it("deleteAgentForOwner : doc + pointeur org + index global retirés ; seconde suppression → false", async () => {
    seedAgent("user-1", "a1", { name: "Cible", orgId: "org-1" });
    seedPointer("org-1", "user-1", "a1");
    seedGlobalIndex("a1", "user-1");

    expect(await deleteAgentForOwner("user-1", "a1")).toBe(true);
    expect(r2State.store.has("users/user-1/agents/a1.json")).toBe(false);
    expect(r2State.store.has("orgs/org-1/agents/a1.json")).toBe(false);
    expect(r2State.store.has("agents-index/a1.json")).toBe(false);
    expect(await deleteAgentForOwner("user-1", "a1")).toBe(false);
  });

  it("deleteAgentForUser non autorisé : false, rien n'est supprimé", async () => {
    seedAgent("user-2", "a1", { name: "Cible", orgId: "org-1" });
    seedPointer("org-1", "user-2", "a1");
    seedGlobalIndex("a1", "user-2");
    expect(await deleteAgentForUser("user-3", "a1")).toBe(false);
    expect(r2State.store.has("users/user-2/agents/a1.json")).toBe(true);
    expect(r2State.store.has("orgs/org-1/agents/a1.json")).toBe(true);
    expect(r2State.store.has("agents-index/a1.json")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// countActiveAgentsOfType
// ---------------------------------------------------------------------------

describe("countActiveAgentsOfType", () => {
  it("compte type + statut actif uniquement, plafonné à 5 (sémantique Firestore limit(5))", async () => {
    for (let i = 0; i < 7; i += 1) seedAgent("user-1", `code-${i}`, { name: `Code ${i}`, type: "code" });
    seedAgent("user-1", "paused", { name: "En pause", type: "code", status: "paused" });
    seedAgent("user-1", "universal", { name: "Universel", type: "universal" });

    expect(await countActiveAgentsOfType("user-1", "code")).toBe(5);
    expect(await countActiveAgentsOfType("user-1", "universal")).toBe(1);
    expect(await countActiveAgentsOfType("user-1", "voice")).toBe(0);
    expect(await countActiveAgentsOfType("user-2", "code")).toBe(0);
  });
});
