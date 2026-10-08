import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 108-b — LA base de données d'identités R2 (couche stockage).
 *
 * Mock R2 EN MÉMOIRE (Map) — même approche que lib/execution/workspace-
 * durability.test.ts : on teste le vrai store contre un R2 simulé fidèle
 * (NoSuchKey pour clé absente, plafond de lecture, listage par préfixe).
 */

const r2State = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
  uploads: [] as string[],
  failUpload: false,
  failDownload: false,
  failDelete: false,
  failList: false,
}));

vi.mock("@/lib/storage/r2", () => ({
  putObject: async (options: { key: string; body: Uint8Array | Buffer; contentType: string; contentLength?: number }) => {
    if (r2State.failUpload) throw new Error("R2 upload impossible (mock)");
    const body = Buffer.from(options.body);
    r2State.store.set(options.key, body);
    r2State.uploads.push(options.key);
  },
  downloadFromR2: async (key: string, maxBytes?: number) => {
    if (r2State.failDownload) throw new Error("R2 lecture impossible (mock)");
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
    return body;
  },
  deleteFromR2: async (key: string) => {
    if (r2State.failDelete) throw new Error("R2 suppression impossible (mock)");
    r2State.store.delete(key);
  },
  listObjectsUnderPrefix: async (prefix: string, maxResults?: number) => {
    if (r2State.failList) throw new Error("R2 listage impossible (mock)");
    return [...r2State.store.keys()]
      .filter((key) => key.startsWith(prefix))
      .slice(0, maxResults ?? 500)
      .map((key) => ({ key, sizeBytes: r2State.store.get(key)!.length, updatedAt: "" }));
  },
}));

import {
  IDENTITY_MAX_BYTES,
  IdentityError,
  assertTailleIdentite,
  deleteIdentity,
  getIdentity,
  identityKey,
  listIdentities,
  putIdentity,
  serializeIdentity,
} from "./r2-identity-store";
import type { Identity } from "./schema";

function identiteValide(uid = "uid-store-1"): Identity {
  const maintenant = new Date().toISOString();
  return {
    uid,
    email: "user@example.com",
    emailVerified: true,
    displayName: "Utilisateur Store",
    firstName: "Utilisateur",
    lastName: "Store",
    username: "userstore",
    photoURL: "https://cdn.example.com/avatar.png",
    phoneNumber: "+237600000001",
    country: "Cameroun",
    bio: "Bio de test.",
    language: "fr",
    timezone: "UTC",
    theme: "dark",
    providers: ["password"],
    plan: "free",
    role: "user",
    status: "active",
    createdAt: maintenant,
    updatedAt: maintenant,
    lastLoginAt: maintenant,
    identityVersion: 1,
  };
}

beforeEach(() => {
  r2State.store.clear();
  r2State.uploads.length = 0;
  r2State.failUpload = false;
  r2State.failDownload = false;
  r2State.failDelete = false;
  r2State.failList = false;
});

describe("putIdentity / getIdentity — aller-retour", () => {
  it("round-trip complet : l'identité stockée se relit à l'identique", async () => {
    const identite = identiteValide();
    await putIdentity(identite);
    expect(r2State.uploads).toEqual(["identities/uid-store-1.json"]);
    const relue = await getIdentity("uid-store-1");
    expect(relue).toEqual(identite);
  });

  it("sérialisation canonique : clés triées + contenu-type application/json", async () => {
    await putIdentity(identiteValide());
    const brut = r2State.store.get("identities/uid-store-1.json")!.toString("utf8");
    const parsed = JSON.parse(brut) as Record<string, unknown>;
    const cles = Object.keys(parsed);
    expect(cles).toEqual([...cles].sort());
    // La forme canonique est stable : resérialiser donne la même chaîne.
    expect(brut).toBe(serializeIdentity(parsed as unknown as Identity));
  });

  it("identité absente → null (NoSuchKey/404 traduit en absence)", async () => {
    await expect(getIdentity("uid-absent")).resolves.toBeNull();
  });

  it("la réécriture remplace le document (pas de duplication d'objet)", async () => {
    const identite = identiteValide();
    await putIdentity(identite);
    const modifiee = { ...identite, displayName: "Nouveau Nom" };
    await putIdentity(modifiee);
    expect(r2State.uploads.filter((key) => key === "identities/uid-store-1.json")).toHaveLength(2);
    await expect(getIdentity("uid-store-1")).resolves.toEqual(modifiee);
  });
});

describe("getIdentity — documents corrompus / trop grands", () => {
  it("JSON invalide → IdentityError corrupted", async () => {
    r2State.store.set("identities/uid-store-1.json", Buffer.from("{ pas du json"));
    await expect(getIdentity("uid-store-1")).rejects.toMatchObject({
      name: "IdentityError",
      code: "corrupted",
    });
  });

  it("JSON valide mais hors schéma → IdentityError corrupted", async () => {
    r2State.store.set("identities/uid-store-1.json", Buffer.from(JSON.stringify({ uid: "uid-store-1" })));
    await expect(getIdentity("uid-store-1")).rejects.toMatchObject({ code: "corrupted" });
  });

  it("objet > plafond de lecture (128 Ko) → IdentityError too_large", async () => {
    r2State.store.set("identities/uid-store-1.json", Buffer.alloc(200 * 1024, 1));
    await expect(getIdentity("uid-store-1")).rejects.toMatchObject({ code: "too_large" });
  });

  it("panne R2 (non-absence) → erreur brute propagée", async () => {
    r2State.failDownload = true;
    await expect(getIdentity("uid-store-1")).rejects.toThrow("R2 lecture impossible (mock)");
  });
});

describe("putIdentity — gardes d'écriture", () => {
  it("garde 64 Ko : un document trop grand → IdentityError too_large (rien écrit)", () => {
    expect(() => assertTailleIdentite(Buffer.alloc(IDENTITY_MAX_BYTES + 1, 0))).toThrow(IdentityError);
    expect(() => assertTailleIdentite(Buffer.alloc(IDENTITY_MAX_BYTES, 0))).not.toThrow();
  });

  it("identité non conforme au schéma → IdentityError corrupted (jamais de ZodError brute)", async () => {
    await expect(putIdentity({ uid: "uid-store-1" } as unknown as Identity)).rejects.toMatchObject({
      code: "corrupted",
    });
    expect(r2State.uploads).toHaveLength(0);
  });

  it("panne R2 à l'écriture → erreur brute propagée", async () => {
    r2State.failUpload = true;
    await expect(putIdentity(identiteValide())).rejects.toThrow("R2 upload impossible (mock)");
  });
});

describe("uid hostile — jamais composé en clé", () => {
  const hostiles = ["../x", "a/b", "", "a b", "uid$.json", "u".repeat(129)];

  it("get/put/delete rejettent un uid hostile AVANT tout accès R2", async () => {
    for (const uid of hostiles) {
      await expect(getIdentity(uid)).rejects.toMatchObject({ code: "invalid" });
      await expect(putIdentity({ ...identiteValide(), uid })).rejects.toMatchObject({ code: "invalid" });
      await expect(deleteIdentity(uid)).rejects.toMatchObject({ code: "invalid" });
    }
    // Aucune clé n'a jamais été composée : le stockage est resté vierge.
    expect(r2State.store.size).toBe(0);
    expect(r2State.uploads).toHaveLength(0);
  });

  it("identityKey compose la clé canonique pour un uid sain", () => {
    expect(identityKey("uid-store-1")).toBe("identities/uid-store-1.json");
  });
});

describe("deleteIdentity — idempotence", () => {
  it("suppression d'une clé absente → succès (idempotent)", async () => {
    await expect(deleteIdentity("uid-absent")).resolves.toBeUndefined();
  });

  it("suppression d'une identité existante → document parti", async () => {
    await putIdentity(identiteValide());
    await deleteIdentity("uid-store-1");
    await expect(getIdentity("uid-store-1")).resolves.toBeNull();
  });

  it("panne R2 à la suppression → erreur brute propagée", async () => {
    r2State.failDelete = true;
    await expect(deleteIdentity("uid-store-1")).rejects.toThrow("R2 suppression impossible (mock)");
  });
});

describe("listIdentities — pagination audit/RGPD", () => {
  it("liste triée, page bornée, curseur de continuation", async () => {
    for (const uid of ["uid-c", "uid-a", "uid-b"]) {
      await putIdentity(identiteValide(uid));
    }
    const page1 = await listIdentities({ limit: 2 });
    expect(page1.uids).toEqual(["uid-a", "uid-b"]);
    expect(page1.nextCursor).toBe("uid-b");

    const page2 = await listIdentities({ limit: 2, cursor: page1.nextCursor });
    expect(page2.uids).toEqual(["uid-c"]);
    expect(page2.nextCursor).toBeUndefined();
  });

  it("limite plafonnée à 100 et défaut 50", async () => {
    const page = await listIdentities({ limit: 5000 });
    expect(page.uids).toEqual([]);
    // Pas d'exception : la borne haute est silencieusement appliquée.
    await expect(listIdentities({ limit: -3 })).resolves.toMatchObject({ uids: [] });
  });

  it("les clés non conformes (uid hostile injecté directement) sont ignorées", async () => {
    await putIdentity(identiteValide("uid-a"));
    r2State.store.set("identities/../evil.json", Buffer.from("{}"));
    r2State.store.set("identities/trash.txt", Buffer.from("{}"));
    const page = await listIdentities();
    expect(page.uids).toEqual(["uid-a"]);
  });

  it("panne R2 au listage → erreur brute propagée", async () => {
    r2State.failList = true;
    await expect(listIdentities()).rejects.toThrow("R2 listage impossible (mock)");
  });
});
