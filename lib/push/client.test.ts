import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Tests du client Web Push (Task 100-b) : environnement node, stubs globaux
 * minimaux (window/navigator/Notification) à la manière du dépôt — aucune
 * dépendance jsdom. Le client Firebase authentifié est mocké : on vérifie
 * ici la logique pure (conversion de clé, corps de requêtes, détection de
 * support) et le contrat serveur Task 100 (POST/DELETE /api/push/subscribe).
 */

const authFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/firebase/auth-client", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...(args as [])),
}));

import {
  buildSubscribeBody,
  buildUnsubscribeBody,
  isPushSupported,
  snapshotFromSubscription,
  subscribeToPush,
  unsubscribeFromPush,
  urlBase64ToUint8Array,
  type PushSubscriptionSnapshot,
} from "./client";

/** Clé VAPID publique de test : 65 octets → 87 caractères base64url. */
const TEST_KEY = (() => {
  const bytes = new Uint8Array(65);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 37 + 11) % 256;
  return Buffer.from(bytes).toString("base64url");
})();

const okResponse = { ok: true } as Response;
const koResponse = { ok: false } as Response;

function makeSubscription(overrides: Partial<PushSubscriptionSnapshot> = {}) {
  const snapshot: PushSubscriptionSnapshot = {
    endpoint: "https://push.example.com/send/abc123",
    expirationTime: null,
    keys: { p256dh: "BPk2xQ", auth: "aBcDeF" },
    ...overrides,
  };
  return {
    endpoint: snapshot.endpoint,
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({
      endpoint: snapshot.endpoint,
      expirationTime: snapshot.expirationTime,
      keys: { ...snapshot.keys },
    }),
  };
}

function makeRegistration() {
  return {
    pushManager: {
      getSubscription: vi.fn(async () => null),
      subscribe: vi.fn(async (_options: PushManagerSubscribeOptions) => makeSubscription()),
    },
  };
}

/** Environnement navigateur complet : push supporté + permission accordée. */
function installPushEnvironment(registration = makeRegistration()) {
  vi.stubGlobal("window", { PushManager: {} });
  vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve(registration) } });
  vi.stubGlobal("Notification", { permission: "granted" });
  return registration;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  authFetchMock.mockReset();
});

describe("urlBase64ToUint8Array — clé VAPID → applicationServerKey", () => {
  it("décode une clé VAPID réelle (65 octets → 87 caractères base64url) en aller-retour", () => {
    expect(TEST_KEY).toHaveLength(87);
    expect(TEST_KEY).not.toContain("+");
    expect(TEST_KEY).not.toContain("/");
    expect(TEST_KEY).not.toContain("=");
    const bytes = new Uint8Array(65);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 37 + 11) % 256;
    expect(Array.from(urlBase64ToUint8Array(TEST_KEY))).toEqual(Array.from(bytes));
  });

  it("complète le padding manquant (vecteur court sans =)", () => {
    expect(Array.from(urlBase64ToUint8Array("AQIDBA"))).toEqual([1, 2, 3, 4]);
  });

  it("convertit les caractères - et _ du alphabet base64url", () => {
    expect(Array.from(urlBase64ToUint8Array("a-b_"))).toEqual([107, 230, 255]);
  });
});

describe("Corps de requêtes — contrat serveur Task 100", () => {
  it("buildSubscribeBody : enveloppe { subscription } avec endpoint + keys + expirationTime", () => {
    const snapshot: PushSubscriptionSnapshot = {
      endpoint: "https://fcm.googleapis.com/fcm/send/xyz",
      expirationTime: 1_700_000_000_000,
      keys: { p256dh: "K-P256", auth: "K_Auth" },
    };
    const body = JSON.parse(buildSubscribeBody(snapshot)) as {
      subscription: Record<string, unknown>;
    };
    expect(body.subscription).toEqual({
      endpoint: "https://fcm.googleapis.com/fcm/send/xyz",
      expirationTime: 1_700_000_000_000,
      keys: { p256dh: "K-P256", auth: "K_Auth" },
    });
  });

  it("buildSubscribeBody : expirationTime absent → champ omis (optionnel au contrat)", () => {
    const body = JSON.parse(
      buildSubscribeBody({ endpoint: "https://push.example.com/e", keys: { p256dh: "a", auth: "b" } }),
    ) as { subscription: Record<string, unknown> };
    expect(body.subscription).toEqual({
      endpoint: "https://push.example.com/e",
      keys: { p256dh: "a", auth: "b" },
    });
    expect("expirationTime" in body.subscription).toBe(false);
  });

  it("buildUnsubscribeBody : corps DELETE = { endpoint }", () => {
    expect(buildUnsubscribeBody("https://push.example.com/send/abc")).toBe(
      '{"endpoint":"https://push.example.com/send/abc"}',
    );
  });

  it("snapshotFromSubscription : aller-simple abonnement navigateur → corps serveur", () => {
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/xyz",
      toJSON: () => ({
        endpoint: "https://fcm.googleapis.com/fcm/send/xyz",
        expirationTime: null,
        keys: { p256dh: "K-P256", auth: "K_Auth" },
      }),
    } as unknown as PushSubscription;
    expect(snapshotFromSubscription(subscription)).toEqual({
      endpoint: "https://fcm.googleapis.com/fcm/send/xyz",
      expirationTime: null,
      keys: { p256dh: "K-P256", auth: "K_Auth" },
    });
    const body = JSON.parse(buildSubscribeBody(snapshotFromSubscription(subscription))) as {
      subscription: Record<string, unknown>;
    };
    expect(body.subscription).toEqual({
      endpoint: "https://fcm.googleapis.com/fcm/send/xyz",
      keys: { p256dh: "K-P256", auth: "K_Auth" },
    });
  });
});

describe("isPushSupported — détection de support", () => {
  it("environnement node sans window → false", () => {
    expect(isPushSupported()).toBe(false);
  });

  it("push complet disponible (window + serviceWorker + PushManager + Notification) → true", () => {
    vi.stubGlobal("window", { PushManager: {} });
    vi.stubGlobal("navigator", { serviceWorker: {} });
    vi.stubGlobal("Notification", { permission: "default" });
    expect(isPushSupported()).toBe(true);
  });

  it("sans PushManager (Safari iOS < 16.4, webview) → false", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { serviceWorker: {} });
    vi.stubGlobal("Notification", { permission: "default" });
    expect(isPushSupported()).toBe(false);
  });

  it("sans service worker → false", () => {
    vi.stubGlobal("window", { PushManager: {} });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("Notification", { permission: "default" });
    expect(isPushSupported()).toBe(false);
  });

  it("sans API Notification → false", () => {
    vi.stubGlobal("window", { PushManager: {} });
    vi.stubGlobal("navigator", { serviceWorker: {} });
    expect(isPushSupported()).toBe(false);
  });
});

describe("subscribeToPush — abonnement serveur", () => {
  it("environnement sans push → 'unsupported', aucun appel réseau", async () => {
    await expect(subscribeToPush()).resolves.toEqual({ ok: false, reason: "unsupported" });
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("permission non accordée → 'permission', aucun appel réseau", async () => {
    vi.stubGlobal("window", { PushManager: {} });
    vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve(makeRegistration()) } });
    vi.stubGlobal("Notification", { permission: "default" });
    await expect(subscribeToPush()).resolves.toEqual({ ok: false, reason: "permission" });
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("clé VAPID publique absente → 'unconfigured' (dégradation gracieuse), aucun appel réseau", async () => {
    installPushEnvironment();
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    await expect(subscribeToPush()).resolves.toEqual({ ok: false, reason: "unconfigured" });
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("abonnement complet : POST /api/push/subscribe avec le corps au contrat + clé décodée", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", TEST_KEY);
    const registration = installPushEnvironment();
    authFetchMock.mockResolvedValue(okResponse);

    await expect(subscribeToPush()).resolves.toEqual({
      ok: true,
      endpoint: "https://push.example.com/send/abc123",
    });

    expect(authFetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(input).toBe("/api/push/subscribe");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as { subscription: Record<string, unknown> };
    expect(body.subscription).toEqual({
      endpoint: "https://push.example.com/send/abc123",
      keys: { p256dh: "BPk2xQ", auth: "aBcDeF" },
    });

    const options = registration.pushManager.subscribe.mock.calls[0][0] as PushManagerSubscribeOptions;
    expect(options.userVisibleOnly).toBe(true);
    expect(Array.from(options.applicationServerKey as Uint8Array)).toEqual(
      Array.from(urlBase64ToUint8Array(TEST_KEY)),
    );
  });

  it("réutilise un abonnement existant (pas de re-souscription)", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", TEST_KEY);
    const existing = makeSubscription();
    const registration = {
      pushManager: {
        getSubscription: vi.fn(async () => existing),
        subscribe: vi.fn(),
      },
    };
    installPushEnvironment(registration);
    authFetchMock.mockResolvedValue(okResponse);

    await expect(subscribeToPush()).resolves.toEqual({ ok: true, endpoint: existing.endpoint });
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("échec d'abonnement navigateur (BadRequestError, clé invalide…) → 'error', jamais de throw", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", TEST_KEY);
    const registration = installPushEnvironment();
    registration.pushManager.subscribe.mockRejectedValue(new Error("BadRequestError: invalid key"));

    await expect(subscribeToPush()).resolves.toEqual({ ok: false, reason: "error" });
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("serveur en échec (HTTP != 200) → 'error'", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", TEST_KEY);
    installPushEnvironment();
    authFetchMock.mockResolvedValue(koResponse);

    await expect(subscribeToPush()).resolves.toEqual({ ok: false, reason: "error" });
  });
});

describe("unsubscribeFromPush — désabonnement idempotent", () => {
  it("environnement sans push → false, aucun appel réseau", async () => {
    await expect(unsubscribeFromPush()).resolves.toBe(false);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("aucun abonnement existant → succès idempotent (true), aucun appel réseau", async () => {
    installPushEnvironment();
    await expect(unsubscribeFromPush()).resolves.toBe(true);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("désabonne le navigateur puis prévient le serveur via DELETE /api/push/subscribe", async () => {
    const subscription = makeSubscription();
    const registration = {
      pushManager: {
        getSubscription: vi.fn(async () => subscription),
        subscribe: vi.fn(),
      },
    };
    installPushEnvironment(registration);
    authFetchMock.mockResolvedValue(okResponse);

    await expect(unsubscribeFromPush()).resolves.toBe(true);
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(input).toBe("/api/push/subscribe");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(String(init.body))).toEqual({ endpoint: subscription.endpoint });
  });

  it("déjà désabonné côté navigateur (unsubscribe → false) → succès sans appel réseau", async () => {
    const subscription = makeSubscription();
    subscription.unsubscribe.mockResolvedValue(false);
    const registration = {
      pushManager: {
        getSubscription: vi.fn(async () => subscription),
        subscribe: vi.fn(),
      },
    };
    installPushEnvironment(registration);

    await expect(unsubscribeFromPush()).resolves.toBe(true);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("serveur en échec → false", async () => {
    const registration = installPushEnvironment(makeRegistration());
    registration.pushManager.getSubscription.mockResolvedValue(makeSubscription());
    authFetchMock.mockResolvedValue(koResponse);

    await expect(unsubscribeFromPush()).resolves.toBe(false);
  });

  it("erreur navigateur inattendue → false, jamais de throw", async () => {
    vi.stubGlobal("window", { PushManager: {} });
    vi.stubGlobal("Notification", { permission: "granted" });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: vi.fn(async () => {
              throw new Error("InvalidStateError");
            }),
            subscribe: vi.fn(),
          },
        }),
      },
    });

    await expect(unsubscribeFromPush()).resolves.toBe(false);
  });
});
