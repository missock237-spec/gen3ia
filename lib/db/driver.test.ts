import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests du driver de bascule DATA_BACKEND (Task 40, ADR-006).
 *
 * Couverture : résolution du backend (flag + garde de configuration),
 * résolution/provisioning du profil via le pont d'identité avec cache TTL,
 * dégradation propre quand Supabase est absent.
 */

const resolveProfileFromTokenMock = vi.hoisted(() =>
  vi.fn(async () => ({ id: "profile-uuid-1" })),
);

vi.mock("@/lib/supabase/auth-bridge", () => ({
  resolveProfileFromToken: (...args: unknown[]) => resolveProfileFromTokenMock(...(args as [])),
}));

vi.mock("@/lib/supabase/config", () => ({
  isSupabaseAdminConfigured: vi.fn(() => true),
  getSupabaseConfig: vi.fn(() => null),
}));

import {
  isSupabaseBackend,
  resolveDataBackendInfo,
  resolveProfileId,
  resetProfileCacheForTests,
  type IdentityForBackend,
} from "./driver";

describe("driver DATA_BACKEND (bascule Firestore ⇄ Supabase)", () => {
  beforeEach(() => {
    resetProfileCacheForTests();
    resolveProfileFromTokenMock.mockClear();
    resolveProfileFromTokenMock.mockImplementation(async () => ({ id: "profile-uuid-1" }));
    vi.stubEnv("DATA_BACKEND", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("défaut : firebase quand aucun flag n'est posé", () => {
    vi.stubEnv("DATA_BACKEND", undefined as unknown as string);
    const info = resolveDataBackendInfo();
    expect(info.backend).toBe("firebase");
    expect(info.requestedSupabase).toBe(false);
    expect(isSupabaseBackend()).toBe(false);
  });

  it("honore DATA_BACKEND=supabase quand la configuration est présente", () => {
    vi.stubEnv("DATA_BACKEND", "supabase");
    const info = resolveDataBackendInfo();
    expect(info.backend).toBe("supabase");
    expect(info.requestedSupabase).toBe(true);
    expect(isSupabaseBackend()).toBe(true);
  });

  it("REPLIE sur firebase quand le flag demande supabase mais la configuration est absente (garde)", async () => {
    vi.stubEnv("DATA_BACKEND", "supabase");
    const { isSupabaseAdminConfigured } = await import("@/lib/supabase/config");
    vi.mocked(isSupabaseAdminConfigured).mockReturnValueOnce(false);

    const info = resolveDataBackendInfo();
    expect(info.backend).toBe("firebase");
    expect(info.requestedSupabase).toBe(true);
    expect(info.supabaseConfigured).toBe(false);
  });

  it("résout l'identité via le pont et met en cache le profil", async () => {
    const identity: IdentityForBackend = { uid: "uid-A" };
    expect(await resolveProfileId(identity)).toBe("profile-uuid-1");
    expect(await resolveProfileId(identity)).toBe("profile-uuid-1");
    // Le pont n'est appelé QU'UNE FOIS pour deux résolutions (cache TTL).
    expect(resolveProfileFromTokenMock).toHaveBeenCalledTimes(1);
    expect(resolveProfileFromTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "uid-A" }),
    );
  });

  it("retourne null sans levée quand le pont échoue (pas de crash pour un pont)", async () => {
    resolveProfileFromTokenMock.mockRejectedValueOnce(new Error("postgres down"));
    expect(await resolveProfileId({ uid: "uid-B" })).toBeNull();
  });

  it("isole deux utilisateurs (clés de cache distinctes)", async () => {
    resolveProfileFromTokenMock
      .mockResolvedValueOnce({ id: "profile-A" })
      .mockResolvedValueOnce({ id: "profile-B" });
    expect(await resolveProfileId({ uid: "uid-A" })).toBe("profile-A");
    expect(await resolveProfileId({ uid: "uid-B" })).toBe("profile-B");
  });
});
