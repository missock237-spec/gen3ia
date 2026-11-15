import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests de l'index vectoriel des conversations :
 *  - fail-soft sans configuration (aucune exception ne remonte) ;
 *  - point déterministe (même messageId → même UUID de point) ;
 *  - payload multi-tenant complet (userId + conversationId + preview) ;
 *  - recherche : mapping des hits, filtrage des conversations vides,
 *    null en cas d'indisponibilité Qdrant (distinguable d'un résultat vide) ;
 *  - regroupement bestHitPerConversation (dédoublonnage + meilleur score).
 */

const mockUpsert = vi.fn();
const mockSearch = vi.fn();
const mockEmbed = vi.fn();

vi.mock("@/lib/memory/vector-store", () => ({
  upsertVectorPoints: (...args: unknown[]) => mockUpsert(...args),
  searchVectorPoints: (...args: unknown[]) => mockSearch(...args),
}));

vi.mock("@/lib/memory/embeddings", () => ({
  createMemoryEmbedding: (...args: unknown[]) => mockEmbed(...args),
}));

import {
  bestHitPerConversation,
  indexConversationMessage,
  searchConversationMessages,
} from "./vector-index";

beforeEach(() => {
  vi.clearAllMocks();
  mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
});

describe("indexConversationMessage", () => {
  it("retourne false sans lever pour un contenu trop court", async () => {
    const result = await indexConversationMessage({
      messageId: "msg1",
      conversationId: "conv1",
      userId: "user1",
      role: "user",
      content: "  ",
    });
    expect(result).toBe(false);
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("indexe avec un point déterministe et un payload complet", async () => {
    mockUpsert.mockResolvedValue(true);

    const input = {
      messageId: "msg-abc",
      conversationId: "conv-1",
      userId: "user-1",
      role: "assistant",
      content: "Voici le plan de lancement marketing pour septembre.",
      createdAt: "2026-09-23T08:00:00.000Z",
      projectId: "proj-1",
    };

    const first = await indexConversationMessage(input);
    const second = await indexConversationMessage(input);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(mockUpsert).toHaveBeenCalledTimes(2);

    const firstCall = mockUpsert.mock.calls[0][1][0] as { id: string; payload: Record<string, unknown> };
    const secondCall = mockUpsert.mock.calls[1][1][0] as { id: string; payload: Record<string, unknown> };

    // Idempotence : le même message réindexé écrase le point, pas de doublon.
    expect(firstCall.id).toBe(secondCall.id);
    expect(firstCall.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(firstCall.payload.userId).toBe("user-1");
    expect(firstCall.payload.conversationId).toBe("conv-1");
    expect(firstCall.payload.messageId).toBe("msg-abc");
    expect(firstCall.payload.projectId).toBe("proj-1");
    expect(firstCall.payload.preview).toContain("plan de lancement");
  });

  it("avale l'erreur d'embedding sans jamais la propager", async () => {
    mockEmbed.mockRejectedValue(new Error("HF quota exceeded"));
    const result = await indexConversationMessage({
      messageId: "msg-1",
      conversationId: "conv-1",
      userId: "user-1",
      role: "user",
      content: "Un message quelconque assez long pour être indexé.",
    });
    expect(result).toBe(false);
  });

  it("retourne false si l'upsert échoue (Qdrant indisponible)", async () => {
    mockUpsert.mockResolvedValue(false);
    const result = await indexConversationMessage({
      messageId: "msg-1",
      conversationId: "conv-1",
      userId: "user-1",
      role: "user",
      content: "Un message quelconque assez long pour être indexé.",
    });
    expect(result).toBe(false);
  });
});

describe("searchConversationMessages", () => {
  it("retourne null pour une requête trop courte", async () => {
    expect(await searchConversationMessages("user-1", "a")).toBeNull();
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it("retourne null si l'embedding échoue (repli textuel côté appelant)", async () => {
    mockEmbed.mockRejectedValue(new Error("network"));
    expect(
      await searchConversationMessages("user-1", "comment lancer ma campagne"),
    ).toBeNull();
  });

  it("retourne null quand Qdrant est indisponible (null ≠ résultat vide)", async () => {
    mockSearch.mockResolvedValue(null);
    expect(
      await searchConversationMessages("user-1", "comment lancer ma campagne"),
    ).toBeNull();
  });

  it("mappe les hits et filtre les payload sans conversationId", async () => {
    mockSearch.mockResolvedValue([
      {
        id: "point-1",
        score: 0.91,
        payload: {
          messageId: "m1",
          conversationId: "conv-1",
          role: "user",
          createdAt: "2026-09-23T08:00:00.000Z",
          preview: "Comment fidéliser mes clients ?",
        },
      },
      {
        id: "point-2",
        score: 0.75,
        payload: { messageId: "m2", conversationId: "" },
      },
    ]);

    const hits = await searchConversationMessages("user-1", "fidélisation clients", { limit: 5 });

    expect(hits).not.toBeNull();
    expect(hits).toHaveLength(1);
    expect(hits![0].conversationId).toBe("conv-1");
    expect(hits![0].preview).toContain("fidéliser");
    expect(hits![0].score).toBeCloseTo(0.91, 5);

    // Le filtre userId est bien transmis (sécurité multi-tenant).
    const filterArg = mockSearch.mock.calls[0][2] as { filter: { userId: string } };
    expect(filterArg.filter.userId).toBe("user-1");
  });
});

describe("bestHitPerConversation", () => {
  it("dédoublonne par message puis ne garde que le meilleur hit par conversation", () => {
    const grouped = bestHitPerConversation([
      { messageId: "m1", conversationId: "conv-a", role: "user", preview: "a", createdAt: "", score: 0.7 },
      { messageId: "m2", conversationId: "conv-b", role: "assistant", preview: "b", createdAt: "", score: 0.9 },
      { messageId: "m3", conversationId: "conv-a", role: "user", preview: "c", createdAt: "", score: 0.85 },
      { messageId: "m3", conversationId: "conv-a", role: "user", preview: "c-bis", createdAt: "", score: 0.6 },
      { messageId: "m4", conversationId: "conv-b", role: "user", preview: "d", createdAt: "", score: 0.4 },
    ]);

    expect(grouped).toHaveLength(2);
    // Le meilleur hit de conv-a est m3 (0.85), devant conv-b (0.9) trié…
    // conv-b (0.9) passe devant conv-a (0.85) : tri par pertinence.
    expect(grouped[0].conversationId).toBe("conv-b");
    expect(grouped[0].messageId).toBe("m2");
    expect(grouped[1].conversationId).toBe("conv-a");
    expect(grouped[1].messageId).toBe("m3");
    expect(grouped[1].score).toBeCloseTo(0.85, 5);
  });

  it("retourne une liste vide sans hit", () => {
    expect(bestHitPerConversation([])).toEqual([]);
  });
});
