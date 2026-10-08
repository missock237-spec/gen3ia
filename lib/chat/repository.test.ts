import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 109-b — dépôt chat adossé à la MÉMOIRE R2 PAR UTILISATEUR
 * (users/{uid}/conversations/{cid}.json + .../messages/{ulid}.json).
 *
 * Mock R2 EN MÉMOIRE (Map clé→Buffer) — pattern dépôt
 * (lib/identity/r2-identity-store.test.ts, workspace-durability.test.ts) :
 * NoSuchKey ($metadata 404) sur clé absente, plafond de lecture, listage
 * par préfixe trié lexicographiquement. La couche user-data-store (contrat
 * Task 109-a) s'exécute RÉELLEMENT au-dessus de ce mock — les tests
 * verrouillent le comportement du dépôt ET du contrat de clés.
 */

const r2State = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
  uploads: [] as string[],
  lists: [] as string[],
  /** Clé dont l'ÉCRITURE échoue systématiquement (panne continue). */
  failUploadKey: null as string | null,
  /** Clé dont l'ÉCRITURE échoue UNE SEULE FOIS (incident ponctuel). */
  failUploadKeyOnce: null as string | null,
  failUploadKeyOnceUsed: false,
  failDelete: false,
  failList: false,
}));

vi.mock("@/lib/storage/r2", () => ({
  putObject: async (options: { key: string; body: Uint8Array | Buffer; contentType?: string; contentLength?: number }) => {
    if (r2State.failUploadKey && options.key === r2State.failUploadKey) {
      throw new Error("R2 upload impossible (mock)");
    }
    if (r2State.failUploadKeyOnce && options.key === r2State.failUploadKeyOnce && !r2State.failUploadKeyOnceUsed) {
      r2State.failUploadKeyOnceUsed = true;
      throw new Error("R2 upload impossible une seule fois (mock)");
    }
    const body = Buffer.from(options.body);
    r2State.store.set(options.key, body);
    r2State.uploads.push(options.key);
  },
  downloadFromR2: async (key: string, maxBytes?: number) => {
    const body = r2State.store.get(key);
    if (!body) {
      // Forme réelle du SDK S3 v3 : name = "NoSuchKey" (+ metadata 404).
      const error = new Error("The specified key does not exist.");
      error.name = "NoSuchKey";
      (error as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 404 };
      throw error;
    }
    if (typeof maxBytes === "number" && body.byteLength > maxBytes) {
      throw new Error("R2 object exceeds configured read limit");
    }
    return Buffer.from(body);
  },
  // La couche user-data-store supprime via deleteObject (alias deleteFromR2).
  deleteObject: async (key: string) => {
    if (r2State.failDelete) throw new Error("R2 suppression impossible (mock)");
    r2State.store.delete(key);
  },
  deleteFromR2: async (key: string) => {
    if (r2State.failDelete) throw new Error("R2 suppression impossible (mock)");
    r2State.store.delete(key);
  },
  listObjectsUnderPrefix: async (prefix: string, maxResults?: number) => {
    if (r2State.failList) throw new Error("R2 listage impossible (mock)");
    r2State.lists.push(prefix);
    // S3 liste les clés en ordre lexicographique — le mock imite le service.
    return [...r2State.store.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, maxResults ?? 500)
      .map((key) => ({ key, sizeBytes: r2State.store.get(key)!.length, updatedAt: new Date(0).toISOString() }));
  },
}));

// ---------------------------------------------------------------------------
// Miroir vectoriel : jamais de réseau dans les tests
// ---------------------------------------------------------------------------

vi.mock("@/lib/chat/vector-index", () => ({
  indexConversationMessage: vi.fn(async () => true),
}));

import { indexConversationMessage } from "@/lib/chat/vector-index";
import { newUlid } from "@/lib/storage/user-data-store";
import {
  appendMessage,
  createConversation,
  deleteConversation,
  findLatestConversation,
  getConversation,
  listConversations,
  listMessages,
  renameConversation,
  updateConversation,
} from "./repository";

const ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

function seedJson(key: string, value: unknown): void {
  r2State.store.set(key, Buffer.from(JSON.stringify(value), "utf8"));
}

function lireJson(key: string): Record<string, unknown> {
  return JSON.parse(r2State.store.get(key)!.toString("utf8")) as Record<string, unknown>;
}

function conversationDoc(
  cid: string,
  title: string,
  updatedAt: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    id: cid,
    userId: "user-1",
    title,
    messageCount: 2,
    status: "active",
    createdAt: updatedAt,
    updatedAt,
    ...extras,
  };
}

function metaKey(uid: string, cid: string): string {
  return `users/${uid}/conversations/${cid}.json`;
}

function messagesPrefixOf(uid: string, cid: string): string {
  return `users/${uid}/conversations/${cid}/messages/`;
}

beforeEach(() => {
  r2State.store.clear();
  r2State.uploads.length = 0;
  r2State.lists.length = 0;
  r2State.failUploadKey = null;
  r2State.failUploadKeyOnce = null;
  r2State.failUploadKeyOnceUsed = false;
  r2State.failDelete = false;
  r2State.failList = false;
  vi.mocked(indexConversationMessage).mockClear();
});

// ---------------------------------------------------------------------------
// newUlid — tri chronologique (contrat user-data-store exploité par le dépôt)
// ---------------------------------------------------------------------------

describe("newUlid (contrat Task 109-a)", () => {
  it("26 chars Crockford base32, monotone au sein de la même milliseconde", () => {
    const instant = new Date("2026-01-01T00:00:00.000Z");
    const a = newUlid(instant);
    const b = newUlid(instant);
    const c = newUlid(instant);
    expect(a).toHaveLength(26);
    expect(b).toHaveLength(26);
    expect(c).toHaveLength(26);
    expect(a < b && b < c).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createConversation / getConversation
// ---------------------------------------------------------------------------

describe("createConversation + getConversation (Task 109-b)", () => {
  it("crée la conversation à sa clé canonique (doc v:1, sérialisation canonique)", async () => {
    const conversation = await createConversation("user-1", "Nouvelle conversation", { agentId: "agent-1", projectId: "proj-1" });
    expect(conversation.id).toMatch(ULID_RE);
    expect(conversation.status).toBe("active");
    expect(conversation.messageCount).toBe(0);
    expect(conversation.agentId).toBe("agent-1");
    const key = metaKey("user-1", conversation.id);
    expect(r2State.store.has(key)).toBe(true);
    const doc = lireJson(key);
    expect(doc.v).toBe(1);
    expect(doc.id).toBe(conversation.id);
    expect(doc.userId).toBe("user-1");
    expect(doc.messageCount).toBe(0);
    expect(typeof doc.createdAt).toBe("string");
    // JSON canonique : clés triées récursivement (contrat writeJson).
    const cles = Object.keys(doc);
    expect(cles).toEqual([...cles].sort());
  });

  it("getConversation : garde d'ownership — la conversation d'autrui est null", async () => {
    seedJson(metaKey("user-2", "conv-9"), conversationDoc("conv-9", "Fil privé", "2026-01-02T00:00:00.000Z", { userId: "user-2" }));
    const owned = await getConversation("user-2", "conv-9");
    expect(owned?.title).toBe("Fil privé");
    // La clé est scopée par uid : pour user-1, la conversation n'existe pas.
    const intruder = await getConversation("user-1", "conv-9");
    expect(intruder).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listConversations / findLatestConversation
// ---------------------------------------------------------------------------

describe("listConversations (Task 109-b)", () => {
  it("scan du préfixe : tri updatedAt desc, filtres agentId/projet/titre, messages exclus", async () => {
    const base = "users/user-1/conversations";
    seedJson(`${base}/c-ancien.json`, conversationDoc("c-ancien", "Ancien", "2026-01-01T00:00:00.000Z", { agentId: "agent-1" }));
    seedJson(`${base}/c-recent.json`, conversationDoc("c-recent", "Récent", "2026-01-03T00:00:00.000Z", { agentId: "agent-1", projectId: "proj-1" }));
    seedJson(`${base}/c-moyen.json`, conversationDoc("c-moyen", "Moyen", "2026-01-02T00:00:00.000Z", { agentId: "agent-1" }));
    seedJson(`${base}/c-autre.json`, conversationDoc("c-autre", "Autre agent", "2026-01-04T00:00:00.000Z", { agentId: "agent-2" }));
    // Un message sous le préfixe ne doit JAMAIS être pris pour une conversation.
    seedJson(`${base}/c-recent/messages/01ARZ3NDEKTSV4RRFFQ69G5FAA.json`, { v: 1, role: "user", content: "x" });
    // Une conversation d'un autre utilisateur n'est jamais listée (clé scopée).
    seedJson("users/user-2/conversations/c-etranger.json", conversationDoc("c-etranger", "Étranger", "2026-01-05T00:00:00.000Z", { userId: "user-2" }));

    const list = await listConversations("user-1", 50, { agentId: "agent-1" });
    expect(list.map((c) => c.id)).toEqual(["c-recent", "c-moyen", "c-ancien"]);
    expect(list.every((c) => typeof c.id === "string" && c.id.length > 0)).toBe(true);
    // Le listage a bien scanné le PRÉFIXE conversations/ (pas messages/).
    expect(r2State.lists).toContain("users/user-1/conversations/");

    const parProjet = await listConversations("user-1", 50, { projectId: "proj-1" });
    expect(parProjet.map((c) => c.id)).toEqual(["c-recent"]);

    const parTitre = await listConversations("user-1", 50, { query: "  MOYEN " });
    expect(parTitre.map((c) => c.id)).toEqual(["c-moyen"]);
  });

  it("la limite demandée borne le résultat APRES tri (cap 100)", async () => {
    const base = "users/user-1/conversations";
    for (let index = 1; index <= 5; index += 1) {
      seedJson(`${base}/c-${index}.json`, conversationDoc(`c-${index}`, `Fil ${index}`, `2026-01-0${index}T00:00:00.000Z`));
    }
    expect((await listConversations("user-1", 3)).map((c) => c.id)).toEqual(["c-5", "c-4", "c-3"]);
    expect((await listConversations("user-1", 500))).toHaveLength(5);
  });
});

describe("findLatestConversation (Task 109-b)", () => {
  it("renvoie la plus récente par updatedAt (réutilise listConversations limit 1)", async () => {
    const base = "users/user-1/conversations";
    seedJson(`${base}/c-1.json`, conversationDoc("c-1", "Ancienne", "2026-01-01T00:00:00.000Z"));
    seedJson(`${base}/c-2.json`, conversationDoc("c-2", "Dernière", "2026-01-09T00:00:00.000Z"));
    const latest = await findLatestConversation("user-1");
    expect(latest?.id).toBe("c-2");
    expect(await findLatestConversation("user-vide")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// appendMessage
// ---------------------------------------------------------------------------

describe("appendMessage (Task 109-b)", () => {
  const input = {
    conversationId: "",
    userId: "user-1",
    role: "user" as const,
    content: "Bonjour",
  };

  it("message = objet propre (v:1, id=ulid), méta patchée (compteur + dernier message)", async () => {
    const conv = await createConversation("user-1", "Fil", { projectId: "proj-1" });
    const saved = await appendMessage({ ...input, conversationId: conv.id });
    expect(saved.id).toMatch(ULID_RE);
    expect(saved.generationStatus).toBe("complete");
    expect(saved.createdAt).not.toBe("");

    const key = `${messagesPrefixOf("user-1", conv.id)}${saved.id}.json`;
    const doc = lireJson(key);
    expect(doc.v).toBe(1);
    expect(doc.id).toBe(saved.id);
    expect(doc.ulid).toBe(saved.id);
    expect(doc.content).toBe("Bonjour");

    const meta = lireJson(metaKey("user-1", conv.id));
    expect(meta.messageCount).toBe(1);
    expect(meta.lastMessagePreview).toBe("Bonjour");
    expect(meta.lastMessageAt).toBe(saved.createdAt);
    expect(meta.updatedAt).toBe(saved.createdAt);

    // Miroir vectoriel best-effort, avec le projectId capturé de la méta.
    expect(indexConversationMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: saved.id, conversationId: conv.id, role: "user", projectId: "proj-1" }),
    );
  });

  it("conversation d'autrui → 'Conversation introuvable.', RIEN n'est écrit", async () => {
    seedJson(metaKey("user-2", "conv-9"), conversationDoc("conv-9", "Fil", "2026-01-02T00:00:00.000Z", { userId: "user-2" }));
    await expect(appendMessage({ ...input, conversationId: "conv-9" })).rejects.toThrow("Conversation introuvable.");
    expect(r2State.uploads).toHaveLength(0);
  });

  it("patch méta best-effort : un échec persistant (1 retry) n'annule JAMAIS le message", async () => {
    const conv = await createConversation("user-1", "Fil");
    r2State.failUploadKey = metaKey("user-1", conv.id);
    const saved = await appendMessage({ ...input, conversationId: conv.id });
    const doc = lireJson(`${messagesPrefixOf("user-1", conv.id)}${saved.id}.json`);
    expect(doc.content).toBe("Bonjour");
    // La méta n'a pas bougé (les deux tentatives de patch ont échoué).
    expect(lireJson(metaKey("user-1", conv.id)).messageCount).toBe(0);
  });

  it("patch méta : le retry aboutit après un incident ponctuel d'écriture", async () => {
    const conv = await createConversation("user-1", "Fil");
    r2State.failUploadKeyOnce = metaKey("user-1", conv.id);
    await appendMessage({ ...input, conversationId: conv.id });
    expect(lireJson(metaKey("user-1", conv.id)).messageCount).toBe(1);
  });

  it("tri chronologique ULID : deux appends SÉQUENTIELS (même ms) restent ordonnés", async () => {
    const conv = await createConversation("user-1", "Fil");
    const premier = await appendMessage({ ...input, conversationId: conv.id, content: "Premier" });
    const second = await appendMessage({ ...input, conversationId: conv.id, content: "Deuxième" });
    expect(premier.id < second.id).toBe(true);
    const messages = await listMessages("user-1", conv.id, 10);
    expect(messages.map((m) => m.content)).toEqual(["Premier", "Deuxième"]);
  });

  it("concurrence : deux appends PARALLÈLES → les DEUX messages sont persistés (objets propres)", async () => {
    const conv = await createConversation("user-1", "Fil");
    const [a, b] = await Promise.all([
      appendMessage({ ...input, conversationId: conv.id, content: "Premier" }),
      appendMessage({ ...input, conversationId: conv.id, content: "Deuxième" }),
    ]);
    expect(a.id).not.toBe(b.id);
    const messages = await listMessages("user-1", conv.id, 10);
    expect(messages).toHaveLength(2);
    expect([...messages.map((m) => m.content)].sort()).toEqual(["Deuxième", "Premier"]);
    // Compteur best-effort : au moins un patch a abouti (pas de compteur
    // partagé — les deux MESSAGES, eux, sont garantis).
    expect(Number(lireJson(metaKey("user-1", conv.id)).messageCount)).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// listMessages — fenêtres
// ---------------------------------------------------------------------------

describe("listMessages fenêtres (Task 109-b)", () => {
  it("asc = début du fil, recent = fin du fil (toujours chronologiques)", async () => {
    const conv = await createConversation("user-1", "Fil");
    for (const contenu of ["un", "deux", "trois", "quatre"]) {
      await appendMessage({ conversationId: conv.id, userId: "user-1", role: "user", content: contenu });
    }
    const debut = await listMessages("user-1", conv.id, 2);
    expect(debut.map((m) => m.content)).toEqual(["un", "deux"]);
    const fin = await listMessages("user-1", conv.id, 2, { order: "recent" });
    expect(fin.map((m) => m.content)).toEqual(["trois", "quatre"]);
  });

  it("conversation absente ou d'autrui → 'Conversation introuvable.'", async () => {
    await expect(listMessages("user-1", "conv-absente", 10)).rejects.toThrow("Conversation introuvable.");
    seedJson(metaKey("user-2", "conv-9"), conversationDoc("conv-9", "Fil", "2026-01-02T00:00:00.000Z", { userId: "user-2" }));
    await expect(listMessages("user-1", "conv-9", 10)).rejects.toThrow("Conversation introuvable.");
  });
});

// ---------------------------------------------------------------------------
// renameConversation / updateConversation
// ---------------------------------------------------------------------------

describe("renameConversation + updateConversation (Task 109-b)", () => {
  it("renomme : titre tronqué/nettoyé, updatedAt rafraîchi", async () => {
    const conv = await createConversation("user-1", "Fil");
    const avant = String(lireJson(metaKey("user-1", conv.id)).updatedAt);
    await renameConversation("user-1", conv.id, "  Nouveau titre  ");
    const meta = lireJson(metaKey("user-1", conv.id));
    expect(meta.title).toBe("Nouveau titre");
    expect(String(meta.updatedAt) >= avant).toBe(true);
    await expect(renameConversation("user-1", "conv-absente", "X")).rejects.toThrow("Conversation introuvable.");
  });

  it("updateConversation : rattache agent/statut/modèle ; projectId:null RETIRE la clé", async () => {
    const conv = await createConversation("user-1", "Fil");
    const maj = await updateConversation("user-1", conv.id, { projectId: "proj-1", agentId: "agent-1", status: "archived", model: "glm-4", provider: "zai" });
    let meta = lireJson(metaKey("user-1", conv.id));
    expect(meta.projectId).toBe("proj-1");
    expect(meta.agentId).toBe("agent-1");
    expect(meta.status).toBe("archived");
    expect(maj?.status).toBe("archived");

    const detach = await updateConversation("user-1", conv.id, { projectId: null });
    meta = lireJson(metaKey("user-1", conv.id));
    expect("projectId" in meta).toBe(false);
    expect(detach?.projectId).toBeUndefined();

    await expect(updateConversation("user-1", "conv-absente", { agentId: "a" })).rejects.toThrow("Conversation introuvable.");
  });
});

// ---------------------------------------------------------------------------
// deleteConversation
// ---------------------------------------------------------------------------

describe("deleteConversation (Task 109-b)", () => {
  it("purge le préfixe messages/ PUIS la méta — plus aucun objet du fil", async () => {
    const conv = await createConversation("user-1", "Fil");
    await appendMessage({ conversationId: conv.id, userId: "user-1", role: "user", content: "un" });
    await appendMessage({ conversationId: conv.id, userId: "user-1", role: "assistant", content: "deux" });
    expect([...r2State.store.keys()].some((key) => key.startsWith(messagesPrefixOf("user-1", conv.id)))).toBe(true);

    await deleteConversation("user-1", conv.id);

    const restants = [...r2State.store.keys()].filter((key) => key.startsWith(`users/user-1/conversations/${conv.id}`));
    expect(restants).toHaveLength(0);
  });

  it("conversation d'autrui → 'Conversation introuvable.', rien n'est supprimé", async () => {
    seedJson(metaKey("user-2", "conv-1"), conversationDoc("conv-1", "Fil", "2026-01-02T00:00:00.000Z", { userId: "user-2" }));
    await expect(deleteConversation("user-1", "conv-1")).rejects.toThrow("Conversation introuvable.");
    expect(r2State.store.has(metaKey("user-2", "conv-1"))).toBe(true);
  });

  it("panne R2 à la purge → erreur propagée, la méta reste en place", async () => {
    const conv = await createConversation("user-1", "Fil");
    await appendMessage({ conversationId: conv.id, userId: "user-1", role: "user", content: "un" });
    r2State.failDelete = true;
    // La couche user-data-store classifie la panne : UserDataError unavailable.
    await expect(deleteConversation("user-1", conv.id)).rejects.toThrow(/indisponible en suppression/);
    expect(r2State.store.has(metaKey("user-1", conv.id))).toBe(true);
  });
});
