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

  it("les Paramètres exposent l'activation (demande de permission au clic, jamais au chargement)", () => {
    const setting = read("components/notifications/native-notifications-setting.tsx");
    expect(setting).toContain("requestNativeNotifications");
    const settings = read("app/settings/page.tsx");
    expect(settings).toContain("NativeNotificationsSetting");
  });
});
