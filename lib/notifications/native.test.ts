import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  alreadyShownThisSession,
  isNativeNotificationsEnabled,
  markShownThisSession,
  setNativeNotificationsEnabled,
  shouldShowNativeNotification,
} from "./native";

/**
 * Étape 18 du plan 20 — notifications natives de l'appareil : la logique
 * d'éligibilité et la déduplication sont PURES et testées sans navigateur
 * (stub mémoire de l'API Storage).
 */

type Store = Record<string, string>;
function memoryStorage() {
  const store: Store = {};
  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => { store[key] = String(value); },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { for (const key of Object.keys(store)) delete store[key]; },
  };
}

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
  } as unknown as Window;
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("shouldShowNativeNotification — éligibilité stricte", () => {
  const base = { permission: "granted" as const, enabled: true, isHidden: true, alreadyShown: false };

  it("affiche quand tout est réuni (permission + choix + onglet caché + jamais montrée)", () => {
    expect(shouldShowNativeNotification(base)).toBe(true);
  });

  it("n'affiche JAMAIS sans le choix explicite de l'utilisateur", () => {
    expect(shouldShowNativeNotification({ ...base, enabled: false })).toBe(false);
  });

  it("n'affiche JAMAIS sans permission accordée (default/denied/unsupported)", () => {
    expect(shouldShowNativeNotification({ ...base, permission: "default" })).toBe(false);
    expect(shouldShowNativeNotification({ ...base, permission: "denied" })).toBe(false);
    expect(shouldShowNativeNotification({ ...base, permission: "unsupported" })).toBe(false);
  });

  it("n'affiche pas si l'utilisateur regarde déjà l'application (pas de spam)", () => {
    expect(shouldShowNativeNotification({ ...base, isHidden: false })).toBe(false);
  });

  it("déduplication : une même notification n'est jamais montrée deux fois", () => {
    expect(shouldShowNativeNotification({ ...base, alreadyShown: true })).toBe(false);
  });
});

describe("shouldShowNativeNotification — passe de rattrapage au retour d'onglet (Task 99-b)", () => {
  // Contexte : le polling est en PAUSE quand l'onglet est caché — un item né
  // pendant l'absence n'a jamais pu passer le critère isHidden. Au retour
  // visible, la fenêtre [eligibleWhileVisibleSince → ∞) le rend éligible.
  const visibleBase = { permission: "granted" as const, enabled: true, isHidden: false, alreadyShown: false };

  it("item né pendant l'absence (strictement après la borne) → éligible au retour visible", () => {
    expect(
      shouldShowNativeNotification({ ...visibleBase, eligibleWhileVisibleSince: 10_000, createdAtMs: 10_500 }),
    ).toBe(true);
  });

  it("item antérieur à la fenêtre de rattrapage → non éligible (jamais de rejeu d'historique)", () => {
    expect(
      shouldShowNativeNotification({ ...visibleBase, eligibleWhileVisibleSince: 10_000, createdAtMs: 9_000 }),
    ).toBe(false);
  });

  it("borne exclusive : un item exactement à la borne est exclu (créé avant le masquage)", () => {
    expect(
      shouldShowNativeNotification({ ...visibleBase, eligibleWhileVisibleSince: 10_000, createdAtMs: 10_000 }),
    ).toBe(false);
  });

  it("sans fenêtre armée (ou fenêtre nulle), la règle historique tient : visible = silence", () => {
    expect(shouldShowNativeNotification({ ...visibleBase, createdAtMs: 999_999 })).toBe(false);
    expect(
      shouldShowNativeNotification({ ...visibleBase, eligibleWhileVisibleSince: 0, createdAtMs: 999_999 }),
    ).toBe(false);
  });

  it("sans date de création, le rattrapage ne peut pas être prouvé → non éligible", () => {
    expect(shouldShowNativeNotification({ ...visibleBase, eligibleWhileVisibleSince: 10_000 })).toBe(false);
  });

  it("les gardes strictes restent prioritaires pendant le rattrapage (choix, permission, dédup)", () => {
    const catchUp = { eligibleWhileVisibleSince: 10_000, createdAtMs: 10_500 } as const;
    expect(shouldShowNativeNotification({ ...visibleBase, ...catchUp, enabled: false })).toBe(false);
    expect(shouldShowNativeNotification({ ...visibleBase, ...catchUp, permission: "default" })).toBe(false);
    expect(shouldShowNativeNotification({ ...visibleBase, ...catchUp, permission: "unsupported" })).toBe(false);
    expect(shouldShowNativeNotification({ ...visibleBase, ...catchUp, alreadyShown: true })).toBe(false);
  });

  it("onglet caché : le chemin historique prime (éligible même sans fenêtre de rattrapage)", () => {
    expect(shouldShowNativeNotification({ ...visibleBase, isHidden: true })).toBe(true);
  });
});

describe("Déduplication par session (stockage de session)", () => {
  beforeEach(() => {
    // window vient d'être recréé : sessionStorage vierge à chaque test.
  });

  it("un id marqué devient « déjà montré », les autres non", () => {
    expect(alreadyShownThisSession("notif-1")).toBe(false);
    markShownThisSession("notif-1");
    expect(alreadyShownThisSession("notif-1")).toBe(true);
    expect(alreadyShownThisSession("notif-2")).toBe(false);
  });

  it("le journal de session est plafonné (pas de croissance infinie)", () => {
    for (let i = 0; i < 250; i += 1) markShownThisSession(`notif-${i}`);
    const ids = JSON.parse((globalThis as unknown as { window: { sessionStorage: { getItem(k: string): string | null } } }).window.sessionStorage.getItem("gen3ia-native-shown") ?? "[]") as string[];
    expect(ids.length).toBeLessThanOrEqual(200);
    expect(alreadyShownThisSession("notif-0")).toBe(false); // évicté
    expect(alreadyShownThisSession("notif-249")).toBe(true);
  });
});

describe("Choix utilisateur persisté", () => {
  it("désactivé par défaut (aucune notification sans consentement)", () => {
    expect(isNativeNotificationsEnabled()).toBe(false);
  });

  it("le choix activé/désactivé est persisté", () => {
    setNativeNotificationsEnabled(true);
    expect(isNativeNotificationsEnabled()).toBe(true);
    setNativeNotificationsEnabled(false);
    expect(isNativeNotificationsEnabled()).toBe(false);
  });
});

describe("Câblage production (garde anti-dérive)", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

  it("le service worker gère le CLIC sur les notifications natives (retour dans l'app)", () => {
    expect(read("public/sw.js")).toContain("notificationclick");
    expect(read("public/sw.js")).toContain("openWindow");
  });

  it("le centre de notifications passe par le module natif (opt-in + permission + dédup)", () => {
    const center = read("components/notifications/notification-center.tsx");
    expect(center).toContain("shouldShowNativeNotification");
    expect(center).toContain("showNativeNotification");
    expect(center).toContain("markShownThisSession");
  });

  it("le rattrapage est câblé : le centre mémorise l'absence et passe la fenêtre au module natif", () => {
    const center = read("components/notifications/notification-center.tsx");
    expect(center).toContain("visibilitychange");
    expect(center).toContain("lastHiddenAt");
    expect(center).toContain("eligibleWhileVisibleSince");
    expect(center).toContain("createdAtMs: item.createdAtMs");
  });

  it("deep-link conversation : la notification cible la route dynamique dédiée", () => {
    const center = read("components/notifications/notification-center.tsx");
    expect(center).toContain("/workspace/conversations/");
    // La racine avalait le paramètre de conversation (redirect nu) — ce
    // lien cassé ne doit jamais revenir.
    expect(center).not.toContain("/workspace?c=");
  });

  it("les Paramètres exposent l'activation (demande de permission au clic, jamais au chargement)", () => {
    const setting = read("components/notifications/native-notifications-setting.tsx");
    expect(setting).toContain("requestNativeNotifications");
    const settings = read("app/settings/page.tsx");
    expect(settings).toContain("NativeNotificationsSetting");
  });
});

describe("Câblage push serveur (Task 100-b, garde anti-dérive)", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

  it("l'opt-in natif déclenche l'abonnement push en arrière-plan (non bloquant) et le retire à la désactivation", () => {
    const setting = read("components/notifications/native-notifications-setting.tsx");
    expect(setting).toContain('from "@/lib/push/client"');
    // Fire-and-forget : l'UI ne doit jamais attendre le réseau.
    expect(setting).toContain("void subscribeToPush()");
    expect(setting).toContain("void unsubscribeFromPush()");
  });

  it("le client push parle au contrat serveur Task 100 (POST/DELETE /api/push/subscribe, clé VAPID)", () => {
    const client = read("lib/push/client.ts");
    expect(client).toContain('"/api/push/subscribe"');
    expect(client).toContain('"POST"');
    expect(client).toContain('"DELETE"');
    expect(client).toContain("NEXT_PUBLIC_VAPID_PUBLIC_KEY");
    expect(client).toContain("userVisibleOnly: true");
  });

  it("le texte des Paramètres reste honnête : push réel sous conditions explicites (iOS 16.4, PWA installée)", () => {
    const setting = read("components/notifications/native-notifications-setting.tsx");
    // La promesse honnête (Task 99-b) doit survivre à l'annonce du push réel.
    expect(setting).toContain("16.4");
    expect(setting).toContain("même application fermée");
    expect(setting).toContain("les alertes locales");
  });
});
