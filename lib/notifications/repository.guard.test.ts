import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Garde quota du centre de notifications (Task 110-e).
 *
 * La sonnette est POLLÉE toutes les 25 s par client ouvert (GET
 * /api/notifications → listNotifications + countUnreadNotifications) et
 * deliverMissionToConversation ATTEND createNotification pour la livraison
 * des missions en arrière-plan — sur Firestore brut, sous quota quotidien
 * épuisé, les écritures pendaient SANS lever (Task 97) et retenaient le tick
 * de livraison jusqu'au kill de la fonction.
 *
 * Contrat après fix : chaque touche est bornée (6 s) + disjoncteur, via le
 * MÊME runFirestoreGuarded que la file de missions. Le contrat best-effort
 * est conservé (createNotification → null, jamais de rejet) ; les lectures
 * du centre lèvent quota-classifié (503 actionnable) au lieu de pendre.
 */

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  queryGet: vi.fn(),
  countGet: vi.fn(),
  runTransaction: vi.fn(),
  commit: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => {
      // Chaîne fluide : where/orderBy/limit renvoient un objet qui supporte
      // les mêmes méthodes (les requêtes réelles varient : list, count…).
      const chain = () => ({
        where: vi.fn(() => chain()),
        orderBy: vi.fn(() => chain()),
        limit: vi.fn(() => chain()),
        get: mocks.queryGet,
        count: vi.fn(() => ({ get: mocks.countGet })),
      });
      return {
        doc: vi.fn(() => ({ id: "notif-1", create: mocks.create })),
        ...chain(),
      };
    }),
    runTransaction: mocks.runTransaction,
    batch: vi.fn(() => ({ update: vi.fn(), commit: mocks.commit })),
  },
}));

vi.mock("@/lib/push/server", () => ({
  pushPayloadFromNotification: vi.fn(() => ({ title: "t" })),
  sendPushToUser: vi.fn(async () => undefined),
}));

const cacheDeleteMock = vi.fn(async () => true);
vi.mock("@/lib/cache/redis", () => ({
  cacheDelete: (...args: unknown[]) => cacheDeleteMock(...(args as [])),
}));

const quotaError = () => Object.assign(new Error("Quota exceeded for quota group 'default'."), { code: 8 });

function openBreaker(): void {
  noteFirestoreQuotaError(quotaError());
  noteFirestoreQuotaError(quotaError());
  noteFirestoreQuotaError(quotaError());
}

beforeEach(() => {
  vi.useFakeTimers();
  resetQuotaGuardForTests();
  cacheDeleteMock.mockClear();
  mocks.create.mockReset();
  mocks.queryGet.mockReset();
  mocks.countGet.mockReset();
  mocks.runTransaction.mockReset();
  mocks.commit.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

import { getQuotaGuardStats, noteFirestoreQuotaError, resetQuotaGuardForTests } from "@/lib/db/quota-guard";
import {
  countUnreadNotifications,
  createNotification,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "./repository";

async function outcomeWithinDeadline(pending: Promise<unknown>): Promise<string> {
  return Promise.race([
    pending.then(
      () => "resolved" as const,
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}` as const,
    ),
    vi.advanceTimersByTimeAsync(7_000).then(() => "timeout" as const),
  ]);
}

describe("createNotification sous garde (110-e)", () => {
  const INPUT = {
    userId: "user-1",
    type: "info" as const,
    title: "Mission livrée",
    body: "Terminé.",
    kind: "conversation" as const,
    conversationId: "conv-1",
  };

  it("VERROU 110-e : disjoncteur ouvert → null (fail-soft) immédiat, Firestore JAMAIS touché", async () => {
    openBreaker();
    mocks.create.mockResolvedValue(undefined);
    await expect(createNotification(INPUT)).resolves.toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : écriture qui pend → null AU DÉLAI (livraison de mission plus jamais retenue) + disjoncteur ouvert", async () => {
    mocks.create.mockImplementation(() => new Promise<void>(() => undefined)); // stall
    const outcome = await outcomeWithinDeadline(createNotification(INPUT));
    expect(outcome).toBe("resolved"); // fail-soft conservé : avalé, pas propagé
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(getQuotaGuardStats().state).toBe("open");
  });

  it("chemin nominal inchangé : notification créée + cache invalidé (régression)", async () => {
    mocks.create.mockResolvedValue(undefined);
    const notification = await createNotification(INPUT);
    expect(notification).not.toBeNull();
    expect(notification?.type).toBe("info");
    expect(cacheDeleteMock).toHaveBeenCalledTimes(1);
    expect(getQuotaGuardStats().state).toBe("closed");
  });
});

describe("lectures de la sonnette sous garde (110-e)", () => {
  it("VERROU 110-e : listNotifications, disjoncteur ouvert → rejet quota-classifié immédiat, requête JAMAIS émise", async () => {
    openBreaker();
    mocks.queryGet.mockResolvedValue({ docs: [] });
    await expect(listNotifications("user-1", 30, false)).rejects.toThrow("Firestore sous quota");
    expect(mocks.queryGet).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : countUnreadNotifications, disjoncteur ouvert → rejet immédiat", async () => {
    openBreaker();
    mocks.countGet.mockResolvedValue({ data: () => ({ count: 3 }) });
    await expect(countUnreadNotifications("user-1")).rejects.toThrow("Firestore sous quota");
    expect(mocks.countGet).not.toHaveBeenCalled();
  });

  it("chemin nominal inchangé : liste + compteur (régression)", async () => {
    mocks.queryGet.mockResolvedValue({ docs: [] });
    mocks.countGet.mockResolvedValue({ data: () => ({ count: 0 }) });
    await expect(listNotifications("user-1", 30, false)).resolves.toEqual([]);
    await expect(countUnreadNotifications("user-1")).resolves.toBe(0);
  });
});

describe("marquages lus sous garde (110-e)", () => {
  it("VERROU 110-e : markNotificationRead, disjoncteur ouvert → transaction JAMAIS ouverte", async () => {
    openBreaker();
    mocks.runTransaction.mockResolvedValue(undefined);
    await expect(markNotificationRead("user-1", "n-1")).rejects.toThrow("Firestore sous quota");
    expect(mocks.runTransaction).not.toHaveBeenCalled();
  });

  it("VERROU 110-e : markAllNotificationsRead, disjoncteur ouvert → requête JAMAIS émise, batch JAMAIS commité", async () => {
    openBreaker();
    mocks.queryGet.mockResolvedValue({ empty: true, docs: [] });
    await expect(markAllNotificationsRead("user-1")).rejects.toThrow("Firestore sous quota");
    expect(mocks.queryGet).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("chemin nominal inchangé : transaction + batch (régression)", async () => {
    mocks.runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ get: vi.fn().mockResolvedValue({ exists: true, get: () => "user-1" }), update: vi.fn() }),
    );
    mocks.queryGet.mockResolvedValue({ empty: false, docs: [{ ref: {} }] });
    mocks.commit.mockResolvedValue(undefined);
    await expect(markNotificationRead("user-1", "n-1")).resolves.toBeUndefined();
    await expect(markAllNotificationsRead("user-1")).resolves.toBeUndefined();
    expect(mocks.commit).toHaveBeenCalledTimes(1);
  });
});
