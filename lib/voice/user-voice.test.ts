import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 114-b — VOIX DU JUMEAU : chaîne de sélection de resolveUserVoiceId
 * (priorité defaultVoiceProfileId désigné → isDefault/premier → null) et
 * fail-soft total. Tous les modules externes (jumeau, voice-service, cache)
 * sont mockés in-memory : aucun R2/Firestore réel.
 */

const twinState = vi.hoisted(() => ({
  twinProfile: {} as Record<string, unknown>,
  failRead: false,
}));

vi.mock("@/lib/identity/twin", () => ({
  getTwinProfile: vi.fn(async () => {
    if (twinState.failRead) throw new Error("R2 lecture impossible (mock)");
    return twinState.twinProfile;
  }),
}));

const voiceState = vi.hoisted(() => ({
  profiles: new Map<string, Record<string, unknown>>(),
  failList: false,
}));

vi.mock("@/lib/video/voice-service", () => ({
  getVoiceProfile: vi.fn(async (_userId: string, voiceId: string) =>
    (voiceState.profiles.get(voiceId) ?? null) as never,
  ),
  listVoiceProfiles: vi.fn(async () => {
    if (voiceState.failList) throw new Error("lecture des voix impossible (mock)");
    return [...voiceState.profiles.values()].sort(
      (a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false),
    ) as never;
  }),
}));

vi.mock("@/lib/cache/redis", () => ({
  cacheWrap: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => ({
    value: await loader(),
    hit: false,
  })),
}));

import { resolveUserVoiceId } from "./user-voice";

function profilVoix(id: string, surcharge: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    userId: "user-1",
    name: `Voix ${id}`,
    language: "fr",
    origin: "recording",
    isDefault: false,
    status: "active",
    createdAt: new Date().toISOString(),
    ...surcharge,
  };
}

beforeEach(() => {
  twinState.twinProfile = {};
  twinState.failRead = false;
  voiceState.profiles.clear();
  voiceState.failList = false;
});

describe("resolveUserVoiceId — chaîne de sélection", () => {
  it("priorité 1 : defaultVoiceProfileId désigné → elevenLabsVoiceId de CE profil", async () => {
    voiceState.profiles.set("voix-clonee", profilVoix("voix-clonee", { elevenLabsVoiceId: "EL-CLONEE" }));
    voiceState.profiles.set("voix-defaut", profilVoix("voix-defaut", { isDefault: true, elevenLabsVoiceId: "EL-DEFAUT" }));
    twinState.twinProfile = { defaultVoiceProfileId: "voix-clonee" };

    await expect(resolveUserVoiceId("user-1")).resolves.toBe("EL-CLONEE");
  });

  it("priorité 2 : voix désignée absente → repli sur le profil isDefault", async () => {
    voiceState.profiles.set("voix-defaut", profilVoix("voix-defaut", { isDefault: true, elevenLabsVoiceId: "EL-DEFAUT" }));
    twinState.twinProfile = { defaultVoiceProfileId: "voix-supprimee" };

    await expect(resolveUserVoiceId("user-1")).resolves.toBe("EL-DEFAUT");
  });

  it("la voix désignée SANS elevenLabsVoiceId (recording non cloné) n'est jamais retournée", async () => {
    voiceState.profiles.set("voix-brute", profilVoix("voix-brute", { isDefault: true }));
    twinState.twinProfile = { defaultVoiceProfileId: "voix-brute" };

    await expect(resolveUserVoiceId("user-1")).resolves.toBeNull();
  });

  it("sans defaultVoiceProfileId : profil isDefault d'abord", async () => {
    voiceState.profiles.set("voix-a", profilVoix("voix-a", { elevenLabsVoiceId: "EL-A" }));
    voiceState.profiles.set("voix-b", profilVoix("voix-b", { isDefault: true, elevenLabsVoiceId: "EL-B" }));

    await expect(resolveUserVoiceId("user-1")).resolves.toBe("EL-B");
  });

  it("sans isDefault : le premier profil avec une voix ElevenLabs est utilisé", async () => {
    voiceState.profiles.set("voix-a", profilVoix("voix-a", { elevenLabsVoiceId: "EL-A" }));

    await expect(resolveUserVoiceId("user-1")).resolves.toBe("EL-A");
  });

  it("aucun profil voix (jumeau vide, bibliothèque vide) → null", async () => {
    await expect(resolveUserVoiceId("user-1")).resolves.toBeNull();
  });

  it("profil isDefault sans elevenLabsVoiceId → null (voix plateforme conservée)", async () => {
    voiceState.profiles.set("voix-brute", profilVoix("voix-brute", { isDefault: true }));

    await expect(resolveUserVoiceId("user-1")).resolves.toBeNull();
  });
});

describe("resolveUserVoiceId — fail-soft", () => {
  it("panne de lecture du jumeau → null (jamais de levée)", async () => {
    twinState.failRead = true;
    await expect(resolveUserVoiceId("user-1")).resolves.toBeNull();
  });

  it("panne de lecture de la bibliothèque voix → null (jamais de levée)", async () => {
    voiceState.failList = true;
    await expect(resolveUserVoiceId("user-1")).resolves.toBeNull();
  });
});
