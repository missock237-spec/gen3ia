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
