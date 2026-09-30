import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Étape 1 du plan 20 — cause racine RC3 : `listMessages` renvoyait les N
 * PLUS ANCIENS messages (`orderBy asc + limit`). Sur une conversation
 * longue, le contexte LLM tronquait la fin du fil — l'agent « oubliait »
 * tout ce qui venait d'être dit. L'option `order: "recent"` renvoie les N
 * plus récents, réordonnés chronologiquement.
 */

type Doc = { id: string; data: () => Record<string, unknown> };

function queryChain(docs: Doc[]) {
  const chain = {
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    get: vi.fn(async () => ({ docs })),
  };
  return chain;
}

const messagesChain = queryChain([
  { id: "m3", data: () => ({ conversationId: "conv-1", userId: "user-1", role: "assistant", content: "troisième", createdAt: new Date("2026-01-03T10:00:00Z") }) },
  { id: "m2", data: () => ({ conversationId: "conv-1", userId: "user-1", role: "user", content: "deuxième", createdAt: new Date("2026-01-02T10:00:00Z") }) },
  { id: "m1", data: () => ({ conversationId: "conv-1", userId: "user-1", role: "assistant", content: "premier", createdAt: new Date("2026-01-01T10:00:00Z") }) },
]);

const conversationDoc = {
  exists: true,
  data: () => ({ userId: "user-1", title: "Fil de test", messageCount: 3, createdAt: new Date(), updatedAt: new Date() }),
};

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn((name: string) => {
      if (name === "chatConversations") {
        return { doc: vi.fn(() => ({ get: vi.fn(async () => conversationDoc) })) };
      }
      return messagesChain;
    }),
    runTransaction: vi.fn(),
    batch: vi.fn(),
  },
}));

import { listMessages } from "./repository";

beforeEach(() => {
  vi.clearAllMocks();
  // Firestore renvoie les docs dans l'ordre de la requête : desc → m3, m2, m1.
  messagesChain.get.mockResolvedValue({
    docs: [
      { id: "m3", data: () => ({ conversationId: "conv-1", userId: "user-1", role: "assistant", content: "troisième", createdAt: new Date("2026-01-03T10:00:00Z") }) },
      { id: "m2", data: () => ({ conversationId: "conv-1", userId: "user-1", role: "user", content: "deuxième", createdAt: new Date("2026-01-02T10:00:00Z") }) },
      { id: "m1", data: () => ({ conversationId: "conv-1", userId: "user-1", role: "assistant", content: "premier", createdAt: new Date("2026-01-01T10:00:00Z") }) },
    ],
  } as never);
});

describe("listMessages — ordre de lecture du contexte de conversation", () => {
  it("order \"recent\" : requête DESC et résultat RÉORDONNÉ chronologiquement", async () => {
    const messages = await listMessages("user-1", "conv-1", 30, { order: "recent" });
    expect(messagesChain.orderBy).toHaveBeenCalledWith("createdAt", "desc");
    expect(messages.map((m) => m.content)).toEqual(["premier", "deuxième", "troisième"]);
  });

  it("order par défaut \"asc\" : requête ASC, ordre chronologique direct (affichage du fil)", async () => {
    messagesChain.get.mockResolvedValue({
      docs: [
        { id: "m1", data: () => ({ conversationId: "conv-1", userId: "user-1", role: "assistant", content: "premier", createdAt: new Date("2026-01-01T10:00:00Z") }) },
        { id: "m2", data: () => ({ conversationId: "conv-1", userId: "user-1", role: "user", content: "deuxième", createdAt: new Date("2026-01-02T10:00:00Z") }) },
      ],
    } as never);
    const messages = await listMessages("user-1", "conv-1", 30);
    expect(messagesChain.orderBy).toHaveBeenCalledWith("createdAt", "asc");
    expect(messages.map((m) => m.content)).toEqual(["premier", "deuxième"]);
  });

  it("la limite demandée est transmise telle quelle (plafonnée à 200)", async () => {
    await listMessages("user-1", "conv-1", 20, { order: "recent" });
    expect(messagesChain.limit).toHaveBeenCalledWith(20);
    await listMessages("user-1", "conv-1", 500);
    expect(messagesChain.limit).toHaveBeenCalledWith(200);
  });

  it("REPLI sans index : la requête triée qui échoue dégrade en tri mémoire sans casser le contexte", async () => {
    // 1er get (requête DESC ordonnée) : FAILED_PRECONDITION simulé.
    messagesChain.get.mockRejectedValueOnce(new Error("The query requires an index."));
    messagesChain.get.mockResolvedValueOnce({
      docs: [
        { id: "m2", data: () => ({ conversationId: "conv-1", userId: "user-1", role: "user", content: "deuxième", createdAt: new Date("2026-01-02T10:00:00Z") }) },
        { id: "m1", data: () => ({ conversationId: "conv-1", userId: "user-1", role: "assistant", content: "premier", createdAt: new Date("2026-01-01T10:00:00Z") }) },
        { id: "m3", data: () => ({ conversationId: "conv-1", userId: "user-1", role: "assistant", content: "troisième", createdAt: new Date("2026-01-03T10:00:00Z") }) },
      ],
    } as never);
    const messages = await listMessages("user-1", "conv-1", 30, { order: "recent" });
    expect(messages.map((m) => m.content)).toEqual(["premier", "deuxième", "troisième"]);
  });
});
