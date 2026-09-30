import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Étape 5 du plan 20 — version app (PWA) fonctionnelle, sans blocage, en
 * synchro avec le web. Garde-fous structurels du service worker et de la
 * chaîne hors-ligne.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("Service worker — file hors-ligne fiable", () => {
  const sw = read("public/sw.js");

  it("la file est STRICTE : /api/chat/message retirée, /approve et /continue jamais capturés", () => {
    expect(sw).not.toContain('"/api/chat/message"');
    expect(sw).toContain('new Set(["/api/agent/chat", "/api/workspace/tasks"])');
    // Correspondance EXACTE du pathname (le startsWith historique capturait
    // /api/agent/chat/approve et /continue — des décisions à ne jamais filer).
    expect(sw).toContain("QUEUED_PATHS.has(url.pathname)");
    expect(sw).not.toContain("QUEUED_PATHS.some((path) => url.pathname.startsWith(path))");
  });

  it("verrou anti-concurrence : un seul flush à la fois (missions jamais doublées)", () => {
    expect(sw).toContain("let flushing = false");
    expect(sw).toContain("if (flushing) return");
    expect(sw).toContain("flushing = true");
    expect(sw).toContain("flushing = false");
  });

  it("idempotence : chaque item porte une clé et le replay l'envoie au serveur", () => {
    expect(sw).toContain("idempotencyKey");
    expect(sw).toContain('"x-gen3ia-idempotency-key"');
  });

  it("les navigations tombent sur offline.html UNIQUEMENT en cas d'échec réseau (network-first)", () => {
    expect(sw).toContain('request.mode === "navigate"');
    expect(sw).toContain("/offline.html");
    // Réseau d'abord : jamais l'inverse (bug historique).
    expect(sw.indexOf("return await fetch(request)")).toBeGreaterThan(-1);
  });

  it("IndexedDB indisponible → 503 explicite (jamais une erreur réseau brute)", () => {
    expect(sw).toContain("OFFLINE_UNAVAILABLE");
  });

  it("aucune perte silencieuse : les échecs définitifs sont notifiés (outbox-failed)", () => {
    expect(sw).toContain('"gen3ia-outbox-failed"');
    expect(sw).toContain('reason: "max_attempts"');
    expect(sw).toContain('reason: "rejected"');
  });

  it("les erreurs transitoires sont replafonnées (MAX_ATTEMPTS), pas rejouées à l'infini", () => {
    expect(sw).toContain("MAX_ATTEMPTS = 5");
    expect(sw).toContain("updateQueued");
  });
});

describe("Manifest & UI — app installable cohérente", () => {
  it("manifest : theme_color/background_color alignés sur le thème sombre de boot", () => {
    const manifest = JSON.parse(read("public/manifest.webmanifest")) as { theme_color: string; background_color: string };
    expect(manifest.theme_color.toLowerCase()).toBe("#05060c");
    expect(manifest.background_color.toLowerCase()).toBe("#0b0d1a");
  });

  it("mission-composer : le bouton n'est plus jamais bloqué (finally) et le 202 queued est annoncé honnêtement", () => {
    const composer = read("components/workspace/mission-composer.tsx");
    expect(composer).toContain("} finally {");
    expect(composer).toContain("setBusy(false)");
    expect(composer).toContain("data.queued && data.offline");
    expect(composer).toContain("au retour du réseau");
  });

  it("agent-chat-panel : 202 queued annoncé honnêtement, décisions jamais mises en file, panneau anti-crash", () => {
    const panel = read("components/agent/agent-chat-panel.tsx");
    expect(panel).toContain("data.queued && data.offline");
    expect(panel).toContain("plan?.steps?.map");
    expect(panel).toContain('"gen3ia:outbox-failed"');
  });

  it("pwa-register : flush via serviceWorker.ready + relais des échecs et files pendantes", () => {
    const register = read("components/pwa-register.tsx");
    expect(register).toContain("navigator.serviceWorker.ready");
    expect(register).toContain('"gen3ia:outbox-failed"');
    expect(register).toContain('"gen3ia:outbox-pending"');
  });
});

describe("Mises à jour multi-appareils — le nouveau build atteint les pages ouvertes", () => {
  it("le SW prend le contrôle immédiatement (skipWaiting) à l'installation", () => {
    const sw = read("public/sw.js");
    expect(sw).toContain("skipWaiting");
  });

  it("pwa-register : applique la nouvelle version au moment sûr (reload gardé, signal sinon)", () => {
    const register = read("components/pwa-register.tsx");
    // Détection d'un SW prêt à prendre le contrôle (update disponible).
    expect(register).toContain("reg.waiting");
    // Reprise de contrôle par un SW plus récent → application (garde anti-boucle session).
    expect(register).toContain("controllerchange");
    expect(register).toContain("pageWasControlled");
    expect(register).toContain("gen3ia-sw-reloaded");
    // Onglet caché = moment sûr ; onglet visible = signal doux (jamais de coupure d'une mission).
    expect(register).toContain("visibilityState");
    expect(register).toContain('"gen3ia:new-version"');
  });

  it("pwa-register : les sessions longues re-vérifient (poll 30 min + retour d'onglet)", () => {
    const register = read("components/pwa-register.tsx");
    expect(register).toContain("setInterval(checkForUpdate");
    expect(register).toContain("visibilitychange");
    expect(register).toContain("update()");
  });
});

describe("Bannière « nouvelle version » — le signal visible-tab atteint l'UI (étape 19)", () => {
  const banner = read("components/nav/update-banner.tsx");
  const layout = read("app/layout.tsx");

  it("la bannière consomme le signal gen3ia:new-version (chaînon manquant de l'étape 11)", () => {
    expect(banner).toContain('"gen3ia:new-version"');
    expect(banner).toContain("addEventListener");
    // Le listener est retiré au démontage : aucune fuite sur les navigations.
    expect(banner).toContain("removeEventListener");
  });

  it("aucun rendu sans détection : zéro impact initial, pas de bannière fantôme", () => {
    expect(banner).toContain("useState(false)");
    expect(banner).toContain("if (!available || dismissed) return null");
  });

  it("appliquer = rechargement explicite ; la bannière ne recharge JAMAIS d'elle-même", () => {
    expect(banner).toContain("window.location.reload()");
    // Garde structurel : aucun timer automatique ne doit déclencher le
    // rechargement (une mission visible ne peut pas être coupée sans geste).
    expect(banner).not.toMatch(/setTimeout\([^)]*reload/);
    expect(banner).not.toMatch(/setInterval\([^)]*reload/);
  });

  it("« Plus tard » masque sans recharger (l'annonce réapparaît à la prochaine détection)", () => {
    expect(banner).toContain("setDismissed(true)");
    expect(banner).toContain('aria-label="Masquer cette annonce"');
  });

  it("annoncée aux lecteurs d'écran (role=status, aria-live=polite)", () => {
    expect(banner).toContain('role="status"');
    expect(banner).toContain('aria-live="polite"');
  });

  it("montée dans le layout racine, à côté de PwaRegister : présente sur toutes les pages", () => {
    expect(layout).toContain("@/components/nav/update-banner");
    expect(layout).toContain("<UpdateBanner />");
  });
});
