import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Étape 1 du plan 20 — cause racine RC3 : `listMessages` renvoyait les N
 * PLUS ANCIENS messages (`orderBy asc + limit`). Sur une conversation
 * longue, le contexte LLM tronquait la fin du fil — l'agent « oubliait »
 * tout ce qui venait d'être dit. L'option `order: "recent"` renvoie les N
 * plus récents, réordonnés chronologiquement.
 *
 * Task 109-b : le fil est reconstitué depuis la MÉMOIRE R2 PAR UTILISATEUR
 * (users/{uid}/conversations/{cid}/messages/{ulid}.json) — le tri
 * lexicographique des clés ULID EST l'ordre chronologique. Les verrous
 * comportementaux RC3 sont inchangés : ordre chronologique, fenêtre
 * demandée, garde d'ownership.
 */

const r2State = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
  lists: [] as string[],
  failList: false,
}));

vi.mock("@/lib/storage/r2", () => ({
  putObject: async (options: { key: string; body: Uint8Array | Buffer }) => {
    r2State.store.set(options.key, Buffer.from(options.body));
  },
  downloadFromR2: async (key: string, maxBytes?: number) => {
    const body = r2State.store.get(key);
    if (!body) {
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
  deleteFromR2: async (key: string) => {
    r2State.store.delete(key);
  },
  // La couche user-data-store supprime via deleteObject (alias deleteFromR2).
  deleteObject: async (key: string) => {
    r2State.store.delete(key);
  },
  listObjectsUnderPrefix: async (prefix: string, maxResults?: number) => {
    if (r2State.failList) throw new Error("R2 listage impossible (mock)");
    r2State.lists.push(prefix);
    return [...r2State.store.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, maxResults ?? 500)
      .map((key) => ({ key, sizeBytes: r2State.store.get(key)!.length, updatedAt: new Date(0).toISOString() }));
  },
}));

vi.mock("@/lib/chat/vector-index", () => ({
  indexConversationMessage: vi.fn(async () => true),
}));

import { listMessages } from "./repository";

const PREFIX_MESSAGES = "users/user-1/conversations/conv-1/messages/";
const META_CONV_1 = "users/user-1/conversations/conv-1.json";

/** Faux ULID 26 chars, zéro-paddé : l'ordre lexicographique = l'ordre numérique. */
function ulid(index: number): string {
  return `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`;
}

function seedMessage(index: number, content: string): void {
  r2State.store.set(
    `${PREFIX_MESSAGES}${ulid(index)}.json`,
    Buffer.from(
      JSON.stringify({
        v: 1,
        id: ulid(index),
        conversationId: "conv-1",
        userId: "user-1",
        ulid: ulid(index),
        role: "assistant",
        content,
        createdAt: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
      }),
      "utf8",
    ),
  );
}

function seedMessages(): void {
  // Insérés EN DÉSORDRE dans le stockage : l'ordre doit venir des CLÉS.
  seedMessage(3, "troisième");
  seedMessage(1, "premier");
  seedMessage(2, "deuxième");
}

beforeEach(() => {
  r2State.store.clear();
  r2State.lists.length = 0;
  r2State.failList = false;
  // La conversation existe et appartient à user-1 (garde d'ownership).
  r2State.store.set(
    META_CONV_1,
    Buffer.from(
      JSON.stringify({
        v: 1,
        id: "conv-1",
        userId: "user-1",
        title: "Fil de test",
        messageCount: 3,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    ),
  );
  seedMessages();
});

describe("listMessages — ordre de lecture du contexte de conversation", () => {
  it("order \"recent\" : les N plus récents RÉORDONNÉS chronologiquement (contexte LLM)", async () => {
    const messages = await listMessages("user-1", "conv-1", 30, { order: "recent" });
    // Le scan a bien porté sur le PRÉFIXE messages/ de la conversation.
    expect(r2State.lists).toContain(PREFIX_MESSAGES);
    expect(messages.map((m) => m.id)).toEqual([ulid(1), ulid(2), ulid(3)]);
    expect(messages.map((m) => m.content)).toEqual(["premier", "deuxième", "troisième"]);
  });

  it("order par défaut \"asc\" : ordre chronologique direct (affichage du fil)", async () => {
    const messages = await listMessages("user-1", "conv-1", 30);
    expect(messages.map((m) => m.content)).toEqual(["premier", "deuxième", "troisième"]);
  });

  it("la limite demandée borne le RÉSULTAT (plafonnée à 200), la fenêtre vient de la FIN des clés", async () => {
    // 22 messages (les 3 premiers sont réécrits avec ce contenu) : les clés
    // ULID se succèdent lexicographiquement.
    for (let index = 1; index <= 22; index += 1) {
      seedMessage(index, `message ${index}`);
    }
    r2State.store.set(
      META_CONV_1,
      Buffer.from(JSON.stringify({ v: 1, id: "conv-1", userId: "user-1", title: "Fil", messageCount: 22, status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }), "utf8"),
    );
    const messages = await listMessages("user-1", "conv-1", 20, { order: "recent" });
    expect(messages).toHaveLength(20);
    // Les 20 PLUS RÉCENTS, chronologiques (le plus ancien des 20 en tête).
    expect(messages[0]!.content).toBe("message 3");
    expect(messages[messages.length - 1]!.content).toBe("message 22");
    // Le tri des clés est lexicographique (= chronologique ULID).
    expect(messages.map((m) => m.id)).toEqual([...messages.map((m) => m.id)].sort());
  });

  it("tri lexicographique des clés : l'ordre du stockage est sans influence (clés = chronologie)", async () => {
    // Les messages ont été semés en désordre (3, 1, 2) : la relecture est
    // néanmoins chronologique, portée par les clés ULID.
    const messages = await listMessages("user-1", "conv-1", 30);
    expect(messages.map((m) => m.id)).toEqual([ulid(1), ulid(2), ulid(3)]);
  });

  it("normalisation des champs métier à la relecture (génération, pièces jointes)", async () => {
    r2State.store.set(
      `${PREFIX_MESSAGES}${ulid(4)}.json`,
      Buffer.from(
        JSON.stringify({
          v: 1,
          id: ulid(4),
          conversationId: "conv-1",
          userId: "user-1",
          ulid: ulid(4),
          role: "user",
          content: "avec pièce jointe",
          attachments: [{ filename: "donnees.csv", fileId: "f-1", fileKind: "csv", charCount: 42, rowCount: 3 }],
          generationStatus: "complete",
          createdAt: new Date(Date.UTC(2026, 0, 1, 4)).toISOString(),
        }),
        "utf8",
      ),
    );
    const messages = await listMessages("user-1", "conv-1", 30);
    const dernier = messages[messages.length - 1]!;
    expect(dernier.generationStatus).toBe("complete");
    expect(dernier.attachments).toEqual([
      { filename: "donnees.csv", path: undefined, url: undefined, contentType: undefined, sizeBytes: undefined, fileId: "f-1", fileKind: "csv", charCount: 42, rowCount: 3 },
    ]);
  });

  it("conversation absente ou d'autrui → 'Conversation introuvable.' (garde d'ownership)", async () => {
    await expect(listMessages("user-1", "conv-absente", 30)).rejects.toThrow("Conversation introuvable.");
    // Même clé de conversation, autre propriétaire : la conversation n'est
    // pas à users/user-2/conversations/conv-1.json → introuvable pour lui.
    await expect(listMessages("user-2", "conv-1", 30)).rejects.toThrow("Conversation introuvable.");
  });
});
