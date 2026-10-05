import { beforeEach, describe, expect, it, vi } from "vitest";

// Firestore est simulé par une carte mémoire (aucun réseau en test) : le
// contrat du module est « jamais de throw » — les pannes sont simulées ici.
const docs = new Map<string, Record<string, unknown>>();
const setPaths: string[] = [];
const deletedPaths: string[] = [];
let firestoreDown = false;

const pathFor = (userId: string, hash: string) => `users/${userId}/pushSubscriptions/${hash}`;

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: (userId: string) => ({
        collection: (sub: string) => ({
          doc: (hash: string) => {
            const path = `${name}/${userId}/${sub}/${hash}`;
            return {
              async get() {
                if (firestoreDown) throw new Error("firestore indisponible");
                const data = docs.get(path);
                return { exists: data !== undefined, get: (field: string) => data?.[field] };
              },
              async set(data: Record<string, unknown>) {
                if (firestoreDown) throw new Error("firestore indisponible");
                setPaths.push(path);
                docs.set(path, { ...data });
              },
              async delete() {
                if (firestoreDown) throw new Error("firestore indisponible");
                deletedPaths.push(path);
                docs.delete(path);
              },
            };
          },
          orderBy: (_field: string, direction: string) => ({
            limit: (_limit: number) => ({
              async get() {
                if (firestoreDown) throw new Error("firestore indisponible");
                const entries = [...docs.entries()];
                if (direction === "desc") {
                  entries.sort((a, b) => Number(b[1].lastSeenAtMs ?? 0) - Number(a[1].lastSeenAtMs ?? 0));
                }
                return { docs: entries.map(([id, data]) => ({ id, data: () => data })) };
              },
            }),
          }),
        }),
      }),
    }),
  },
}));

import {
  deletePushSubscription,
  hashEndpoint,
  listPushSubscriptions,
  truncateUserAgent,
  upsertPushSubscription,
} from "./repository";

/**
 * Task 100 — stockage des abonnements Web Push : identifiant haché,
 * upsert idempotent, erreurs silencieuses (jamais de throw vers l'appelant).
 */

const SUBSCRIPTION = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: { p256dh: "cle-p256dh", auth: "cle-auth" },
};

beforeEach(() => {
  docs.clear();
  setPaths.length = 0;
  deletedPaths.length = 0;
  firestoreDown = false;
});

describe("hashEndpoint", () => {
  it("dérive un identifiant déterministe (sha256 base64url) sans exposer l'URL signée", () => {
    const hash = hashEndpoint(SUBSCRIPTION.endpoint);
    expect(hash).toBe(hashEndpoint(SUBSCRIPTION.endpoint));
    expect(hash).not.toContain("fcm.googleapis.com");
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("deux endpoints distincts donnent deux identifiants distincts", () => {
    expect(hashEndpoint("https://push.example/1")).not.toBe(hashEndpoint("https://push.example/2"));
  });
});

describe("upsertPushSubscription", () => {
  it("écrit les champs attendus (endpoint, clés, expiration, agent, horodatages)", async () => {
    const ok = await upsertPushSubscription("user-1", { ...SUBSCRIPTION, expirationTime: 1234, userAgent: "Navigateur Test/1.0" });
    expect(ok).toBe(true);
    expect(setPaths).toHaveLength(1);
    const data = docs.get(setPaths[0]);
    expect(data?.endpoint).toBe(SUBSCRIPTION.endpoint);
    expect(data?.p256dh).toBe("cle-p256dh");
    expect(data?.auth).toBe("cle-auth");
    expect(data?.expirationTime).toBe(1234);
    expect(data?.userAgent).toBe("Navigateur Test/1.0");
    expect(typeof data?.createdAtMs).toBe("number");
    expect(typeof data?.lastSeenAtMs).toBe("number");
  });

  it("souscription répétée : MÊME document (hash endpoint), createdAtMs conservé, clés fraîches", async () => {
    await upsertPushSubscription("user-1", SUBSCRIPTION);
    const first = docs.get(setPaths[0]);
    expect(first).toBeDefined();
    first!.createdAtMs = 111;
    await upsertPushSubscription("user-1", { ...SUBSCRIPTION, keys: { p256dh: "nouvelle-cle", auth: "nouvel-auth" } });
    expect(setPaths).toHaveLength(2);
    expect(setPaths[1]).toBe(setPaths[0]);
    const last = docs.get(setPaths[1]);
    expect(last?.createdAtMs).toBe(111);
    expect(last?.p256dh).toBe("nouvelle-cle");
  });

  it("expirationTime absente → null (jamais undefined)", async () => {
    await upsertPushSubscription("user-1", SUBSCRIPTION);
    expect(docs.get(setPaths[0])?.expirationTime).toBeNull();
  });

  it("entrée invalide (endpoint ou clés vides) → false sans écriture", async () => {
    expect(await upsertPushSubscription("user-1", { ...SUBSCRIPTION, endpoint: "  " })).toBe(false);
    expect(await upsertPushSubscription("user-1", { ...SUBSCRIPTION, keys: { p256dh: "", auth: "a" } })).toBe(false);
    expect(await upsertPushSubscription("", SUBSCRIPTION)).toBe(false);
    expect(setPaths).toHaveLength(0);
  });

  it("user-agent tronqué à 200 caractères (jamais d'entête brut illimité)", () => {
    expect(truncateUserAgent("x".repeat(500))).toHaveLength(200);
    expect(truncateUserAgent(undefined)).toBe("");
  });

  it("Firestore indisponible → false, jamais de throw", async () => {
    firestoreDown = true;
    await expect(upsertPushSubscription("user-1", SUBSCRIPTION)).resolves.toBe(false);
  });
});

describe("deletePushSubscription", () => {
  it("supprime le document HACHÉ (l'endpoint signé n'est jamais un identifiant)", async () => {
    await upsertPushSubscription("user-1", SUBSCRIPTION);
    const ok = await deletePushSubscription("user-1", SUBSCRIPTION.endpoint);
    expect(ok).toBe(true);
    expect(deletedPaths).toEqual([pathFor("user-1", hashEndpoint(SUBSCRIPTION.endpoint))]);
    expect(docs.has(pathFor("user-1", hashEndpoint(SUBSCRIPTION.endpoint)))).toBe(false);
  });

  it("idempotent : endpoint absent → true (contrat DELETE 200 même si absent)", async () => {
    await expect(deletePushSubscription("user-1", "https://push.example/absent")).resolves.toBe(true);
  });

  it("entrée vide → false sans appel", async () => {
    expect(await deletePushSubscription("user-1", "   ")).toBe(false);
    expect(await deletePushSubscription("", SUBSCRIPTION.endpoint)).toBe(false);
    expect(deletedPaths).toHaveLength(0);
  });

  it("Firestore indisponible → false, jamais de throw", async () => {
    firestoreDown = true;
    await expect(deletePushSubscription("user-1", SUBSCRIPTION.endpoint)).resolves.toBe(false);
  });
});

describe("listPushSubscriptions", () => {
  it("liste triée du plus récemment vu au plus ancien (lastSeenAtMs desc)", async () => {
    await upsertPushSubscription("user-1", { ...SUBSCRIPTION, endpoint: "https://push.example/ancien" });
    docs.get(pathFor("user-1", hashEndpoint("https://push.example/ancien")))!.lastSeenAtMs = 1_000;
    await upsertPushSubscription("user-1", { ...SUBSCRIPTION, endpoint: "https://push.example/recent" });
    docs.get(pathFor("user-1", hashEndpoint("https://push.example/recent")))!.lastSeenAtMs = 2_000;
    const list = await listPushSubscriptions("user-1");
    expect(list.map((record) => record.endpoint)).toEqual(["https://push.example/recent", "https://push.example/ancien"]);
    expect(list[0].keys).toEqual({ p256dh: "cle-p256dh", auth: "cle-auth" });
    expect(list[0].expirationTime).toBeNull();
  });

  it("documents incomplets (clés absentes) ignorés — inutilisables pour un envoi", async () => {
    docs.set(pathFor("user-1", "incomplet"), { endpoint: "https://push.example/x", p256dh: "k", auth: "" });
    await expect(listPushSubscriptions("user-1")).resolves.toEqual([]);
  });

  it("utilisateur vide → [] sans requête", async () => {
    await expect(listPushSubscriptions("  ")).resolves.toEqual([]);
  });

  it("Firestore indisponible → [] (jamais de throw)", async () => {
    firestoreDown = true;
    await expect(listPushSubscriptions("user-1")).resolves.toEqual([]);
  });
});
