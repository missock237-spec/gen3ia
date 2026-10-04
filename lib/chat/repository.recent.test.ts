import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Étape 1 du plan 20 — cause racine RC3 : `listMessages` renvoyait les N
 * PLUS ANCIENS messages (`orderBy asc + limit`). Sur une conversation
 * longue, le contexte LLM tronquait la fin du fil — l'agent « oubliait »
 * tout ce qui venait d'être dit. L'option `order: "recent"` renvoie les N
 * plus récents, réordonnés chronologiquement.
 *
 * Task 96-c : les lectures passent par la couche résiliente
 * (lib/db/firestore-fallback) — le filtrage Firestore reste par égalité et
 * le tri est appliqué EN MÉMOIRE (index-safe, quota-safe). Les verrous
 * comportementaux sont inchangés : ordre chronologique, fenêtre demandée,
 * repli sans index.
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

const messagesChain = queryChain([]);

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

const msg = (id: string, content: string, hour: number) => ({
  id,
  data: () => ({ conversationId: "conv-1", userId: "user-1", role: "assistant", content, createdAt: new Date(Date.UTC(2026, 0, 1, hour)) }),
});

beforeEach(() => {
  vi.clearAllMocks();
  messagesChain.get.mockResolvedValue({
    docs: [
      msg("m3", "troisième", 3),
      msg("m2", "deuxième", 2),
      msg("m1", "premier", 1),
    ],
  } as never);
});

describe("listMessages — ordre de lecture du contexte de conversation", () => {
  it("order \"recent\" : les N plus récents RÉORDONNÉS chronologiquement (contexte LLM)", async () => {
    const messages = await listMessages("user-1", "conv-1", 30, { order: "recent" });
    // Le filtre Firestore reste par égalité (tri mémoire dans la couche résiliente).
    expect(messagesChain.where).toHaveBeenCalledWith("conversationId", "==", "conv-1");
    expect(messagesChain.where).toHaveBeenCalledWith("userId", "==", "user-1");
    expect(messagesChain.orderBy).not.toHaveBeenCalled();
    expect(messages.map((m) => m.content)).toEqual(["premier", "deuxième", "troisième"]);
  });

  it("order par défaut \"asc\" : ordre chronologique direct (affichage du fil)", async () => {
    const messages = await listMessages("user-1", "conv-1", 30);
    expect(messages.map((m) => m.content)).toEqual(["premier", "deuxième", "troisième"]);
  });

  it("la limite demandée borne le RÉSULTAT (plafonnée à 200), le scan reste borné", async () => {
    messagesChain.get.mockResolvedValue({
      docs: Array.from({ length: 22 }, (_, index) => msg(`m${index + 1}`, `message ${index + 1}`, index)),
    } as never);
    const messages = await listMessages("user-1", "conv-1", 20, { order: "recent" });
    expect(messagesChain.limit).toHaveBeenCalledWith(200);
    expect(messages).toHaveLength(20);
    // Les 20 PLUS RÉCENTS, chronologiques (le plus ancien des 20 en tête).
    expect(messages[0]!.content).toBe("message 3");
    expect(messages[messages.length - 1]!.content).toBe("message 22");
  });

  it("REPLI sans index : la requête triée qui échoue dégrade en tri mémoire sans casser le contexte", async () => {
    // 1er get (requête ordonnée) : FAILED_PRECONDITION simulé.
    messagesChain.get.mockRejectedValueOnce(new Error("The query requires an index."));
    messagesChain.get.mockResolvedValueOnce({
      docs: [
        msg("m2", "deuxième", 2),
        msg("m1", "premier", 1),
        msg("m3", "troisième", 3),
      ],
    } as never);
    const messages = await listMessages("user-1", "conv-1", 30, { order: "recent" });
    expect(messages.map((m) => m.content)).toEqual(["premier", "deuxième", "troisième"]);
  });
});
