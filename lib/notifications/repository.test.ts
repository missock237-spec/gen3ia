import { beforeEach, describe, expect, it, vi } from "vitest";

// Le module testé importe firebase-admin (lourd, indésirable en test) et
// le cache Redis (observé ici via un espion) : les deux sont mockés.
const cacheDeleteMock = vi.fn(async () => true);

vi.mock("@/lib/cache/redis", () => ({
  cacheDelete: (...args: unknown[]) => cacheDeleteMock(...(args as [])),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({})),
  },
}));

import {
  invalidateNotificationsCache,
  notificationsCacheKey,
} from "./repository";

describe("micro-cache sonnette notifications", () => {
  beforeEach(() => {
    cacheDeleteMock.mockClear();
  });

  it("génère une clé canonique déterministe par utilisateur/limite/filtre", () => {
    expect(notificationsCacheKey("user-1", 30, false)).toBe("g3:notif:user-1:30:0");
    expect(notificationsCacheKey("user-1", 30, true)).toBe("g3:notif:user-1:30:1");
    expect(notificationsCacheKey("user-2", 50, false)).toBe("g3:notif:user-2:50:0");
    // Deux appels identiques → même clé (déterministe).
    expect(notificationsCacheKey("user-1", 30, false)).toBe(notificationsCacheKey("user-1", 30, false));
  });

  it("n'isole PAS deux utilisateurs (clés distinctes)", () => {
    expect(notificationsCacheKey("a", 30, false)).not.toBe(notificationsCacheKey("b", 30, false));
  });

  it("invalidateNotificationsCache supprime la forme canonique du polling (30, non filtré)", async () => {
    invalidateNotificationsCache("user-1");
    await Promise.resolve();
    expect(cacheDeleteMock).toHaveBeenCalledTimes(1);
    expect(cacheDeleteMock).toHaveBeenCalledWith("g3:notif:user-1:30:0");
  });

  it("l'invalidation est best-effort : un échec Redis ne doit jamais lever", async () => {
    cacheDeleteMock.mockRejectedValueOnce(new Error("redis down"));
    expect(() => invalidateNotificationsCache("user-1")).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
