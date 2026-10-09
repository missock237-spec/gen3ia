import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ensureUserProfile — politique d'écriture conditionnelle (Task 101, audit
 * quota Firestore) : la fonction est appelée à CHAQUE établissement de
 * session. Le contrat verrouillé ici :
 *  - création d'un profil absent → écriture légitime (set) ;
 *  - profil existant inchangé + login tracé < 1 h → AUCUNE écriture ;
 *  - profil existant inchangé + login > 1 h → 1 update minimal (throttle) ;
 *  - champ réellement modifié (profil ou provider) → 1 update complet.
 * firebase-admin est simulé (lourd et indésirable en test, convention du
 * dépôt) : le Timestamp simulé garde `instanceof` opérationnel.
 */

const firestoreSimulé = vi.hoisted(() => {
  class TimestampSimulé {
    constructor(readonly ms: number) {}
    toMillis(): number {
      return this.ms;
    }
  }
  return {
    sentinelleServerTimestamp: { __serverTimestamp: true },
    Timestamp: TimestampSimulé,
  };
});

const dbSimulé = vi.hoisted(() => {
  const docSimulé = {
    get: vi.fn(),
    set: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
  };
  const adminDb = {
    collection: vi.fn(() => ({ doc: vi.fn(() => docSimulé) })),
  };
  return { docSimulé, adminDb };
});

vi.mock("@/lib/r2fs", () => ({
  FieldValue: { serverTimestamp: () => firestoreSimulé.sentinelleServerTimestamp },
  Timestamp: firestoreSimulé.Timestamp,
}));

vi.mock("./admin", () => ({ adminDb: dbSimulé.adminDb }));

import { ensureUserProfile } from "./users";

const { docSimulé } = dbSimulé;

beforeEach(() => {
  vi.clearAllMocks();
});

function snapshotExistant(data: Record<string, unknown>) {
  docSimulé.get.mockResolvedValue({ exists: true, data: () => data });
}

describe("ensureUserProfile — écriture conditionnelle (quota Firestore)", () => {
  it("profil absent : création légitime via set, jamais via update", async () => {
    docSimulé.get.mockResolvedValue({ exists: false, data: () => ({}) });
    await ensureUserProfile({ uid: "u1", email: "a@b.fr", displayName: "A B", provider: "password" });
    expect(docSimulé.set).toHaveBeenCalledTimes(1);
    expect(docSimulé.update).not.toHaveBeenCalled();
  });

  it("profil existant inchangé + login tracé il y a 10 min : AUCUNE écriture", async () => {
    snapshotExistant({
      email: "a@b.fr",
      displayName: "A B",
      providers: ["password"],
      lastLoginAt: new firestoreSimulé.Timestamp(Date.now() - 10 * 60_000),
    });
    await ensureUserProfile({ uid: "u1", email: "a@b.fr", displayName: "A B", provider: "password" });
    expect(docSimulé.update).not.toHaveBeenCalled();
    expect(docSimulé.set).not.toHaveBeenCalled();
  });

  it("profil inchangé mais login > 1 h : update minimal (throttle lastLoginAt)", async () => {
    snapshotExistant({
      email: "a@b.fr",
      displayName: "A B",
      providers: ["password"],
      lastLoginAt: new firestoreSimulé.Timestamp(Date.now() - 2 * 60 * 60_000),
    });
    await ensureUserProfile({ uid: "u1", email: "a@b.fr", displayName: "A B", provider: "password" });
    expect(docSimulé.update).toHaveBeenCalledTimes(1);
    expect(docSimulé.update).toHaveBeenCalledWith({
      updatedAt: firestoreSimulé.sentinelleServerTimestamp,
      lastLoginAt: firestoreSimulé.sentinelleServerTimestamp,
    });
    expect(docSimulé.set).not.toHaveBeenCalled();
  });

  it("email réellement modifié : update complet (même si le login est récent)", async () => {
    snapshotExistant({
      email: "ancien@b.fr",
      displayName: "A B",
      providers: ["password"],
      lastLoginAt: new firestoreSimulé.Timestamp(Date.now() - 10 * 60_000),
    });
    await ensureUserProfile({ uid: "u1", email: "nouveau@b.fr", displayName: "A B", provider: "password" });
    expect(docSimulé.update).toHaveBeenCalledTimes(1);
    const appel = docSimulé.update.mock.calls[0]![0] as Record<string, unknown>;
    expect(appel.email).toBe("nouveau@b.fr");
    expect(appel.updatedAt).toEqual(firestoreSimulé.sentinelleServerTimestamp);
    expect(appel.lastLoginAt).toEqual(firestoreSimulé.sentinelleServerTimestamp);
  });

  it("provider inédit : le tableau providers change → update", async () => {
    snapshotExistant({
      email: "a@b.fr",
      displayName: "A B",
      providers: ["password"],
      lastLoginAt: new firestoreSimulé.Timestamp(Date.now() - 10 * 60_000),
    });
    await ensureUserProfile({ uid: "u1", email: "a@b.fr", displayName: "A B", provider: "google.com" });
    expect(docSimulé.update).toHaveBeenCalledTimes(1);
    const appel = docSimulé.update.mock.calls[0]![0] as Record<string, unknown>;
    expect(appel.providers).toEqual(["password", "google.com"]);
  });

  it("lastLoginAt absent du document : le login est (re)tracé via update minimal", async () => {
    snapshotExistant({ email: "a@b.fr", displayName: "A B", providers: ["password"] });
    await ensureUserProfile({ uid: "u1", email: "a@b.fr", displayName: "A B", provider: "password" });
    expect(docSimulé.update).toHaveBeenCalledWith({
      updatedAt: firestoreSimulé.sentinelleServerTimestamp,
      lastLoginAt: firestoreSimulé.sentinelleServerTimestamp,
    });
  });
});
