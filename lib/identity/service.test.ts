import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 108-b — logique métier de la base d'identités R2.
 *
 * Le service est testé À TRAVERS le vrai store, contre un mock R2 EN
 * MÉMOIRE (Map) : compteurs de putIdentity, idempotence du provisionnement,
 * throttle du login (miroir Task 101), autorité de l'email vérifié,
 * immutabilité des champs serveur, propagation des pannes.
 */

const r2State = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
  uploads: [] as string[],
  failUpload: false,
  failDownload: false,
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
      const error = new Error("The specified key does not exist.");
      error.name = "NoSuchKey";
      throw error;
    }
    if (typeof maxBytes === "number" && body.byteLength > maxBytes) {
      throw new Error("R2 object exceeds configured read limit");
    }
    return body;
  },
  deleteFromR2: async (key: string) => {
    r2State.store.delete(key);
  },
  listObjectsUnderPrefix: async () => [],
}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

import { IdentityPatchSchema, type Identity, type IdentityPatch } from "./schema";
import { getIdentity, putIdentity } from "./r2-identity-store";
import {
  deleteIdentityForAccount,
  ensureIdentity,
  getIdentitySafe,
  publicIdentity,
  setEmailFromVerifiedToken,
  updateIdentity,
} from "./service";

const UID = "uid-service-1";

function identiteStockee(surcharge: Partial<Identity> = {}): Identity {
  const maintenant = new Date().toISOString();
  return {
    uid: UID,
    email: null,
    emailVerified: false,
    displayName: null,
    firstName: null,
    lastName: null,
    username: null,
    photoURL: null,
    phoneNumber: null,
    country: null,
    bio: null,
    language: "fr",
    timezone: "UTC",
    theme: "dark",
    providers: [],
    plan: "free",
    role: "user",
    status: "active",
    createdAt: maintenant,
    updatedAt: maintenant,
    lastLoginAt: maintenant,
    identityVersion: 1,
    ...surcharge,
  };
}

function ilYa(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

const HEURE = 60 * 60_000;

beforeEach(() => {
  r2State.store.clear();
  r2State.uploads.length = 0;
  r2State.failUpload = false;
  r2State.failDownload = false;
});

describe("ensureIdentity — création", () => {
  it("crée une identité COMPLÈTE avec les défauts du schéma", async () => {
    const identity = await ensureIdentity({
      uid: UID,
      email: "user@example.com",
      displayName: "Utilisateur Service",
      provider: "password",
    });
    expect(identity.uid).toBe(UID);
    expect(identity.email).toBe("user@example.com");
    expect(identity.emailVerified).toBe(false);
    expect(identity.displayName).toBe("Utilisateur Service");
    expect(identity.status).toBe("active");
    expect(identity.plan).toBe("free");
    expect(identity.role).toBe("user");
    expect(identity.theme).toBe("dark");
    expect(identity.language).toBe("fr");
    expect(identity.timezone).toBe("UTC");
    expect(identity.providers).toEqual(["password"]);
    expect(identity.identityVersion).toBe(1);
    expect(identity.createdAt).toBe(identity.updatedAt);
    expect(identity.createdAt).toBe(identity.lastLoginAt);
    // Le document est bien LA source : relu depuis R2, identique.
    await expect(getIdentity(UID)).resolves.toEqual(identity);
  });

  it("crée l'identité avec emailVerified quand le jeton est vérifié", async () => {
    const identity = await ensureIdentity({
      uid: UID,
      email: "user@example.com",
      emailVerified: true,
      provider: "google.com",
    });
    expect(identity.email).toBe("user@example.com");
    expect(identity.emailVerified).toBe(true);
  });
});

describe("ensureIdentity — idempotence (appelé à chaque session)", () => {
  it("deux appels identiques → UN SEUL objet, une seule écriture, pas de doublon de provider", async () => {
    const params = { uid: UID, email: "user@example.com", displayName: "Utilisateur", provider: "password" };
    const premiere = await ensureIdentity(params);
    const deuxieme = await ensureIdentity(params);
    expect(deuxieme).toEqual(premiere);
    expect(r2State.uploads).toHaveLength(1);
    const relue = await getIdentity(UID);
    expect(relue?.providers).toEqual(["password"]);
  });

  it("fusion par REMPLISSAGE DES VIDES : l'existant n'est jamais écrasé", async () => {
    await putIdentity(
      identiteStockee({ displayName: "Nom Existant", email: "ancien@example.com", username: "ancien" }),
    );
    r2State.uploads.length = 0;
    const identity = await ensureIdentity({
      uid: UID,
      email: "nouveau@example.com",
      displayName: "Nom Du Jeton",
      username: "nouveau",
      country: "Cameroun",
    });
    // displayName/username/email existants PRIMES (pas d'écrasement).
    expect(identity.displayName).toBe("Nom Existant");
    expect(identity.username).toBe("ancien");
    expect(identity.email).toBe("ancien@example.com");
    // …seul le vide (country null) est rempli.
    expect(identity.country).toBe("Cameroun");
    expect(r2State.uploads).toHaveLength(1);
  });

  it("email null → rempli par le jeton (email null → set)", async () => {
    await putIdentity(identiteStockee({ email: null }));
    r2State.uploads.length = 0;
    const identity = await ensureIdentity({ uid: UID, email: "rempli@example.com" });
    expect(identity.email).toBe("rempli@example.com");
    expect(r2State.uploads).toHaveLength(1);
  });

  it("providers dédupliqués sur des connexions variées", async () => {
    await ensureIdentity({ uid: UID, provider: "password" });
    const identity = await ensureIdentity({ uid: UID, provider: "google.com" });
    expect(identity.providers).toEqual(["password", "google.com"]);
    await ensureIdentity({ uid: UID, provider: "password" });
    expect(r2State.uploads).toHaveLength(2); // google.com a écrit, password non
  });
});

describe("ensureIdentity — throttle du login (miroir Task 101)", () => {
  it("login retracé < 1 h → ZÉRO écriture", async () => {
    await putIdentity(identiteStockee({ lastLoginAt: ilYa(10 * 60_000), providers: ["password"] }));
    r2State.uploads.length = 0;
    await ensureIdentity({ uid: UID, provider: "password" });
    expect(r2State.uploads).toHaveLength(0);
  });

  it("login > 1 h → écriture unique avec lastLoginAt rafraîchi", async () => {
    const ancien = ilYa(2 * HEURE);
    await putIdentity(identiteStockee({ lastLoginAt: ancien, providers: ["password"] }));
    r2State.uploads.length = 0;
    const identity = await ensureIdentity({ uid: UID, provider: "password" });
    expect(r2State.uploads).toHaveLength(1);
    expect(identity.lastLoginAt).not.toBe(ancien);
    const relue = await getIdentity(UID);
    expect(relue?.lastLoginAt).not.toBe(ancien);
  });
});

describe("ensureIdentity — autorité de l'email vérifié (setEmailFromVerifiedToken)", () => {
  it("un email vérifié du jeton ÉCRASE un email antérieur non vérifié", async () => {
    await putIdentity(identiteStockee({ email: "ancien@example.com", emailVerified: false }));
    r2State.uploads.length = 0;
    const identity = await ensureIdentity({
      uid: UID,
      email: "verifie@example.com",
      emailVerified: true,
    });
    expect(identity.email).toBe("verifie@example.com");
    expect(identity.emailVerified).toBe(true);
    expect(r2State.uploads).toHaveLength(1);
  });

  it("email déjà vérifié identique → zéro écriture", async () => {
    await putIdentity(identiteStockee({ email: "verifie@example.com", emailVerified: true }));
    r2State.uploads.length = 0;
    const identity = await ensureIdentity({
      uid: UID,
      email: "verifie@example.com",
      emailVerified: true,
    });
    expect(identity.email).toBe("verifie@example.com");
    expect(r2State.uploads).toHaveLength(0);
  });

  it("setEmailFromVerifiedToken : pose l'email, idempotent ; uid inconnu → not_found", async () => {
    await ensureIdentity({ uid: UID });
    r2State.uploads.length = 0;
    const identity = await setEmailFromVerifiedToken(UID, "verifie@example.com");
    expect(identity.email).toBe("verifie@example.com");
    expect(identity.emailVerified).toBe(true);
    expect(r2State.uploads).toHaveLength(1);
    // Second appel : déjà posé → zéro écriture.
    await setEmailFromVerifiedToken(UID, "verifie@example.com");
    expect(r2State.uploads).toHaveLength(1);
    // uid inconnu → not_found.
    await expect(setEmailFromVerifiedToken("uid-inconnu", "x@example.com")).rejects.toMatchObject({
      code: "not_found",
    });
    // Email vide → invalid.
    await expect(setEmailFromVerifiedToken(UID, "   ")).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("ensureIdentity — document corrompu → recréation", () => {
  it("une identité corrompue est recréée par le provisionnement", async () => {
    r2State.store.set(`identities/${UID}.json`, Buffer.from("{ corrompu"));
    const identity = await ensureIdentity({ uid: UID, email: "user@example.com", provider: "password" });
    expect(identity.email).toBe("user@example.com");
    expect(identity.theme).toBe("dark"); // défauts reposés
    expect(r2State.uploads).toHaveLength(1); // recréation = 1 écriture
  });
});

describe("ensureIdentity / updateIdentity — pannes R2", () => {
  it("lecture impossible → IdentityError unavailable (mode dégradé des routes)", async () => {
    r2State.failDownload = true;
    await expect(ensureIdentity({ uid: UID })).rejects.toMatchObject({
      name: "IdentityError",
      code: "unavailable",
    });
  });

  it("écriture impossible (création) → IdentityError unavailable", async () => {
    r2State.failUpload = true;
    await expect(ensureIdentity({ uid: UID })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("écriture impossible (update) → IdentityError unavailable", async () => {
    await ensureIdentity({ uid: UID });
    r2State.failUpload = true;
    await expect(updateIdentity(UID, { displayName: "X" })).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("updateIdentity — patch utilisateur", () => {
  it("patch valide fusionné + updatedAt rafraîchi", async () => {
    const avant = await ensureIdentity({ uid: UID, email: "user@example.com" });
    const identity = await updateIdentity(UID, { displayName: "Nouveau Nom", theme: "light", bio: "Ma bio." });
    expect(identity.displayName).toBe("Nouveau Nom");
    expect(identity.theme).toBe("light");
    expect(identity.bio).toBe("Ma bio.");
    expect(identity.email).toBe("user@example.com"); // inchangé
    expect(identity.createdAt).toBe(avant.createdAt); // immutable
    expect(identity.updatedAt >= avant.updatedAt).toBe(true);
    const relue = await getIdentity(UID);
    expect(relue?.theme).toBe("light");
  });

  it("champ inconnu → rejeté par le schéma strict (ZodError)", async () => {
    await ensureIdentity({ uid: UID });
    await expect(
      updateIdentity(UID, { champPirate: true } as unknown as IdentityPatch),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("email/role/plan/status immutables : IGNORÉS silencieusement", async () => {
    await ensureIdentity({ uid: UID, email: "user@example.com" });
    const identity = await updateIdentity(UID, {
      email: "pirate@example.com",
      role: "admin",
      plan: "enterprise",
      status: "disabled",
      displayName: "Nom Légitime",
    } as unknown as IdentityPatch);
    expect(identity.email).toBe("user@example.com");
    expect(identity.role).toBe("user");
    expect(identity.plan).toBe("free");
    expect(identity.status).toBe("active");
    expect(identity.displayName).toBe("Nom Légitime"); // le patch légitime passe
  });

  it("identité absente → IdentityError not_found", async () => {
    await expect(updateIdentity("uid-inconnu", { displayName: "X" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("deleteIdentityForAccount / getIdentitySafe / publicIdentity", () => {
  it("suppression RGPD puis idempotence (second appel sans erreur)", async () => {
    await ensureIdentity({ uid: UID });
    await deleteIdentityForAccount(UID);
    await expect(getIdentity(UID)).resolves.toBeNull();
    await expect(deleteIdentityForAccount(UID)).resolves.toBeUndefined();
  });

  it("getIdentitySafe : corrupted → null, unavailable → null, sans lever", async () => {
    r2State.store.set(`identities/${UID}.json`, Buffer.from("{ corrompu"));
    await expect(getIdentitySafe(UID)).resolves.toBeNull();
    r2State.store.clear();
    r2State.failDownload = true;
    await expect(getIdentitySafe(UID)).resolves.toBeNull();
  });

  it("publicIdentity : projection minimale (aucune donnée privée)", async () => {
    const identite = identiteStockee({ displayName: "Public", email: "prive@example.com" });
    const publique = publicIdentity(identite);
    expect(publique).toEqual({
      uid: UID,
      displayName: "Public",
      photoURL: null,
      theme: "dark",
      createdAt: identite.createdAt,
    });
    expect(JSON.stringify(publique)).not.toContain("prive@example.com");
  });
});

describe("contrats de schéma (gards d'intégration)", () => {
  it("IdentityPatchSchema n'expose AUCUN champ immutable", () => {
    const champs = Object.keys(IdentityPatchSchema.shape);
    expect(champs).toEqual(
      expect.arrayContaining(["displayName", "theme", "language", "timezone"]),
    );
    for (const immutable of ["email", "role", "plan", "status", "uid", "providers", "identityVersion"]) {
      expect(champs).not.toContain(immutable);
    }
  });
});
