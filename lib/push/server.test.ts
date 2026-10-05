import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Le stockage et la bibliothèque web-push sont simulés : ce qui est testé
// ici est le COMPORTEMENT du wrapper — deep-link aligné sur le centre de
// notifications, no-op sans VAPID, nettoyage des abonnements morts (404/410),
// budget de charge utile et masquage des champs sensibles.
const listSubscriptionsMock = vi.fn();
const deleteSubscriptionMock = vi.fn();

vi.mock("./repository", () => ({
  listPushSubscriptions: (...args: unknown[]) => listSubscriptionsMock(...(args as [string])),
  deletePushSubscription: (...args: unknown[]) => deleteSubscriptionMock(...(args as [string, string])),
}));

const setVapidDetailsMock = vi.fn();
const sendNotificationMock = vi.fn();

vi.mock("web-push", () => ({
  setVapidDetails: (...args: unknown[]) => setVapidDetailsMock(...(args as [string, string, string])),
  sendNotification: (...args: unknown[]) => sendNotificationMock(...(args as [unknown, string])),
}));

import {
  compactPayload,
  isPushConfigured,
  maskedEndpoint,
  notificationUrlFrom,
  pushPayloadFromNotification,
  sendPushToUser,
} from "./server";

/** Injecte (ou retire) les variables VAPID — la clé privée ne vit QUE ici, en mémoire. */
function setVapidEnv(publicKey?: string, privateKey?: string, subject?: string) {
  if (publicKey) process.env.VAPID_PUBLIC_KEY = publicKey;
  else delete process.env.VAPID_PUBLIC_KEY;
  if (privateKey) process.env.VAPID_PRIVATE_KEY = privateKey;
  else delete process.env.VAPID_PRIVATE_KEY;
  if (subject) process.env.VAPID_SUBJECT = subject;
  else delete process.env.VAPID_SUBJECT;
}

function record(endpoint: string, lastSeenAtMs: number) {
  return { endpoint, keys: { p256dh: "p", auth: "a" }, expirationTime: null, userAgent: "", createdAtMs: 1, lastSeenAtMs };
}

beforeEach(() => {
  listSubscriptionsMock.mockReset().mockResolvedValue([]);
  deleteSubscriptionMock.mockReset().mockResolvedValue(true);
  setVapidDetailsMock.mockReset();
  sendNotificationMock.mockReset().mockResolvedValue({ statusCode: 201 });
});

afterEach(() => {
  setVapidEnv();
});

describe("notificationUrlFrom — deep-link ALIGNÉ sur notification-center.tsx", () => {
  it("conversation → route dynamique de l'espace de travail", () => {
    expect(notificationUrlFrom({ type: "info", title: "T", body: "", conversationId: "conv-42" })).toBe(
      "/workspace/conversations/conv-42",
    );
  });

  it("identifiant de conversation encodé (caractères spéciaux)", () => {
    expect(notificationUrlFrom({ type: "info", title: "T", body: "", conversationId: "a/b c" })).toBe(
      `/workspace/conversations/${encodeURIComponent("a/b c")}`,
    );
  });

  it("tâche studio → /studio?taskId=<executionId>", () => {
    expect(notificationUrlFrom({ type: "info", title: "T", body: "", executionId: "task-7" })).toBe("/studio?taskId=task-7");
  });

  it("sans contexte → /dashboard (URL RELATIVE, jamais absolue)", () => {
    expect(notificationUrlFrom({ type: "info", title: "T", body: "" })).toBe("/dashboard");
  });

  it("la conversation PRIME sur la tâche studio (même ordre que le client)", () => {
    expect(notificationUrlFrom({ type: "info", title: "T", body: "", conversationId: "c", executionId: "e" })).toBe(
      "/workspace/conversations/c",
    );
  });
});

describe("pushPayloadFromNotification — libellés cohérents côté serveur", () => {
  it("validation requise → titre conventionnel (comme les natives du client)", () => {
    const payload = pushPayloadFromNotification({ type: "approval_requested", title: "Accès fichiers", body: "Un agent demande l'accès." });
    expect(payload.title).toBe("Gen3ia — validation requise");
    expect(payload.body).toBe("Un agent demande l'accès.");
  });

  it("information → titre préfixé Gen3ia", () => {
    expect(pushPayloadFromNotification({ type: "info", title: "Mission terminée", body: "Rapport prêt." }).title).toBe(
      "Gen3ia — Mission terminée",
    );
  });

  it("corps absent → repli générique FR", () => {
    expect(pushPayloadFromNotification({ type: "info", title: "T", body: "" }).body).toBe("Une mise à jour de ta mission t'attend.");
  });

  it("corps borné à 300 caractères (comme le client)", () => {
    expect(pushPayloadFromNotification({ type: "info", title: "T", body: "b".repeat(500) }).body).toHaveLength(300);
  });
});

describe("isPushConfigured — dégradation gracieuse sans VAPID", () => {
  it("false sans clés : la plateforme fonctionne sans push (no-op silencieux)", () => {
    expect(isPushConfigured()).toBe(false);
  });

  it("true uniquement quand les DEUX clés sont présentes", () => {
    setVapidEnv("cle-publique", "cle-privee");
    expect(isPushConfigured()).toBe(true);
    setVapidEnv("cle-publique");
    expect(isPushConfigured()).toBe(false);
    setVapidEnv(undefined, "cle-privee");
    expect(isPushConfigured()).toBe(false);
  });

  it("valeurs vides ou placeholders traitées comme absentes", () => {
    setVapidEnv(" ", "null");
    expect(isPushConfigured()).toBe(false);
  });
});

describe("compactPayload — budget strict < 4 Ko", () => {
  it("charge utile inférieure à 4 096 octets même avec un corps très long", () => {
    const payload = compactPayload({ title: "Gen3ia — Mission", body: "b".repeat(10_000), url: "/workspace/conversations/abc" });
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThan(4096);
  });

  it("titre et url vides → replis canoniques", () => {
    expect(compactPayload({ title: "", body: "", url: "" })).toEqual({ title: "Gen3ia", body: "", url: "/dashboard" });
  });

  it("titre borné à 200 caractères (aligné sur le schéma de notification)", () => {
    expect(compactPayload({ title: "t".repeat(400), body: "b", url: "/dashboard" }).title).toHaveLength(200);
  });
});

describe("maskedEndpoint — champs sensibles jamais journalisés", () => {
  it("n'expose ni le protocole, ni le domaine, ni le jeton d'endpoint complet", () => {
    const masked = maskedEndpoint("https://fcm.googleapis.com/fcm/send/secret-token-987654");
    expect(masked).not.toContain("https");
    expect(masked).not.toContain("fcm.googleapis.com");
    expect(masked.endsWith("987654")).toBe(true);
  });

  it("endpoint court → entièrement masqué", () => {
    expect(maskedEndpoint("abc123")).toBe("…");
  });
});

describe("sendPushToUser — envoi best-effort, jamais de throw", () => {
  it("no-op SANS configuration VAPID : aucun envoi, aucune erreur", async () => {
    listSubscriptionsMock.mockResolvedValue([record("https://push.example/a", 1)]);
    await expect(sendPushToUser("user-1", { title: "T", body: "B", url: "/dashboard" })).resolves.toBeUndefined();
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("envoie la charge utile JSON minimale {title, body, url} à chaque abonnement", async () => {
    setVapidEnv("pub-1", "priv-1");
    listSubscriptionsMock.mockResolvedValue([record("https://push.example/a", 1)]);
    await sendPushToUser("user-1", { title: "Bonjour", body: "Nouvelle notification", url: "/dashboard" });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const [subscription, body] = sendNotificationMock.mock.calls[0];
    expect(subscription).toMatchObject({ endpoint: "https://push.example/a", keys: { p256dh: "p", auth: "a" } });
    expect(JSON.parse(body as string)).toEqual({ title: "Bonjour", body: "Nouvelle notification", url: "/dashboard" });
  });

  it("détails VAPID appliqués avec le sujet configuré (VAPID_SUBJECT)", async () => {
    setVapidEnv("pub-sujet", "priv-sujet", "mailto:support@gen3ia.online");
    listSubscriptionsMock.mockResolvedValue([record("https://push.example/sujet", 1)]);
    await sendPushToUser("user-1", { title: "T", body: "B", url: "/dashboard" });
    expect(setVapidDetailsMock).toHaveBeenCalledWith("mailto:support@gen3ia.online", "pub-sujet", "priv-sujet");
  });

  it("détails VAPID memoïsés : setVapidDetails UNE seule fois par couple de clés", async () => {
    setVapidEnv("pub-memo", "priv-memo");
    listSubscriptionsMock.mockResolvedValue([record("https://push.example/memo", 1)]);
    await sendPushToUser("user-1", { title: "T", body: "B", url: "/dashboard" });
    await sendPushToUser("user-1", { title: "T", body: "B", url: "/dashboard" });
    const applied = setVapidDetailsMock.mock.calls.filter((args) => args[1] === "pub-memo");
    expect(applied).toHaveLength(1);
  });

  it("abonnement mort 404/410 → SUPPRIMÉ ; abonnement vivant conservé", async () => {
    setVapidEnv("pub-morts", "priv-morts");
    listSubscriptionsMock.mockResolvedValue([
      record("https://push.example/dead404", 3),
      record("https://push.example/dead410", 2),
      record("https://push.example/vivant", 1),
    ]);
    sendNotificationMock.mockImplementation(async (subscription: { endpoint: string }) => {
      if (subscription.endpoint.endsWith("dead404")) throw Object.assign(new Error("gone"), { statusCode: 404 });
      if (subscription.endpoint.endsWith("dead410")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      return { statusCode: 201 };
    });
    await sendPushToUser("user-1", { title: "T", body: "B", url: "/dashboard" });
    expect(deleteSubscriptionMock).toHaveBeenCalledTimes(2);
    expect(deleteSubscriptionMock.mock.calls.map((args) => args[1])).toEqual(
      expect.arrayContaining(["https://push.example/dead404", "https://push.example/dead410"]),
    );
  });

  it("erreur transitoire 429 (quota) → abonnement CONSERVÉ, aucun throw", async () => {
    setVapidEnv("pub-quota", "priv-quota");
    listSubscriptionsMock.mockResolvedValue([record("https://push.example/quota", 1)]);
    sendNotificationMock.mockImplementation(async () => {
      throw Object.assign(new Error("trop de requêtes"), { statusCode: 429 });
    });
    await expect(sendPushToUser("user-1", { title: "T", body: "B", url: "/dashboard" })).resolves.toBeUndefined();
    expect(deleteSubscriptionMock).not.toHaveBeenCalled();
  });

  it("plafond : au plus 10 abonnements par envoi (les plus récents d'abord — ordre du listage)", async () => {
    setVapidEnv("pub-plafond", "priv-plafond");
    // Le repository renvoie déjà lastSeenAtMs DESC — le 0 est le plus récent.
    const subs = Array.from({ length: 14 }, (_, index) => record(`https://push.example/${index}`, 100 - index));
    listSubscriptionsMock.mockResolvedValue(subs);
    await sendPushToUser("user-1", { title: "T", body: "B", url: "/dashboard" });
    expect(sendNotificationMock).toHaveBeenCalledTimes(10);
    expect((sendNotificationMock.mock.calls[0][0] as { endpoint: string }).endpoint).toBe("https://push.example/0");
  });

  it("panne du listage → no-op silencieux (le flux métier continue)", async () => {
    setVapidEnv("pub-panne", "priv-panne");
    listSubscriptionsMock.mockRejectedValue(new Error("panne infrastructure"));
    await expect(sendPushToUser("user-1", { title: "T", body: "B", url: "/dashboard" })).resolves.toBeUndefined();
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("charge utile envoyée < 4 Ko avec deep-link de conversation", async () => {
    setVapidEnv("pub-taille", "priv-taille");
    listSubscriptionsMock.mockResolvedValue([record("https://push.example/s", 1)]);
    await sendPushToUser(
      "user-1",
      pushPayloadFromNotification({
        type: "approval_requested",
        title: "Accès drive",
        body: "L'agent demande l'accès à Drive pour la mission #12.",
        conversationId: "conv-9",
      }),
    );
    const body = sendNotificationMock.mock.calls[0][1] as string;
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(4096);
    expect(JSON.parse(body).url).toBe("/workspace/conversations/conv-9");
  });
});
