import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * AGENT LIVE — MOTEUR INTERNE GEN3 (it.52) — conventions du dépôt :
 * vitest tourne en Node SANS jsdom ni @testing-library/react. Le
 * câblage du live SOUS LE CHAT IA sur le pipeline INTERNE
 * (components/live/live-interne-panel.tsx — demande propriétaire :
 * « activation depuis le chat IA, live en interne avec gen3 ») est
 * verrouillé structurellement :
 *
 *  1. LES PORTES INTERNES SONT CONSOMMÉES : POST /api/live/sessions
 *     (création réelle), POST /start (armement), POST frames (images →
 *     décisions du moteur de vision interne), PUT frames (résultat
 *     d'action), approve (HITL), stop (arrêt réel).
 *  2. LES SOURCES DE CAPTURE SONT HONNÊTES : écran PC (getDisplayMedia)
 *     OU caméra mobile (getUserMedia, avant/arrière) — la bascule est
 *     explicite, le fallback est annoncé.
 *  3. L'HONNÊTETÉ EST CONSERVÉE : 401 → connexion, HITL d'approbation
 *     inline, actions navigateur non exécutables signalées à la porte
 *     (l'agent observe et décrit), échecs réseau consécutifs visibles
 *     dans le journal, consentement explicite avant activation.
 *  4. ZÉRO CANAL EXTERNE : aucune clé API, aucun service tiers, aucune
 *     référence au client « Gemini Live » retiré.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const PANEL = "components/live/live-interne-panel.tsx";
const CHAT = "components/chat/nova-chat.tsx";

describe("Agent live — moteur interne gen3 sous le chat (câblage it.52)", () => {
  const panel = read(PANEL);
  const chat = read(CHAT);

  it("les portes internes sont consommées dans leurs six modes (création, start, frames, résultat, approbation, arrêt)", () => {
    // POST — création RÉELLE de la session (mode navigateur).
    expect(panel).toContain('authFetch("/api/live/sessions", {');
    expect(panel).toContain('mode: "browser"');
    // POST /start — armement (deviceId).
    expect(panel).toContain("`/api/live/sessions/${sessionId}/start`");
    // POST frames — images → décisions du moteur interne.
    expect(panel).toContain("`/api/live/sessions/${runtime.sessionId}/frames`");
    expect(panel).toContain('method: "POST"');
    // PUT frames — résultat d'action (ok / échec honnête).
    expect(panel).toContain('method: "PUT"');
    // POST approve — HITL depuis le chat.
    expect(panel).toContain("/actions/${pendingApproval.actionId}/approve`");
    // POST stop — arrêt réel de la session.
    expect(panel).toContain('body: JSON.stringify({ action: "stop" })');
  });

  it("les sources de capture sont honnêtes : écran PC (getDisplayMedia) ou caméra mobile (getUserMedia, avant/arrière)", () => {
    expect(panel).toContain("navigator.mediaDevices.getDisplayMedia");
    expect(panel).toContain("navigator.mediaDevices.getUserMedia");
    expect(panel).toContain("facingMode: cameraFacing");
    // La bascule est explicite et accessible (aria-pressed).
    expect(panel).toContain('aria-pressed={source === "screen"}');
    expect(panel).toContain('aria-pressed={source === "camera"}');
    // Le fallback est annoncé (pas de message d'erreur brut).
    expect(panel).toContain("Partage d'écran indisponible dans ce navigateur");
    expect(panel).toContain("Caméra indisponible dans ce navigateur");
  });

  it("l'honnêteté est conservée : connexion, HITL inline, limites navigateur, journal visible, consentement", () => {
    // 401 — message de connexion (carte + activation).
    expect(panel).toContain("Connectez-vous pour activer l&apos;agent live ici, dans le chat.");
    expect(panel).toContain('"Connectez-vous pour activer l\'agent live."');
    // HITL — action sensible approuvée depuis le chat.
    expect(panel).toContain("Action sensible en attente de votre validation");
    expect(panel).toContain('role="status"');
    // Limites navigateur honnêtes (l'agent observe et décrit).
    expect(panel).toContain("Action réservée à un client PC : en mode navigateur, l'agent observe et décrit");
    // Journal visible, jamais avalé (échecs consécutifs signalés).
    expect(panel).toContain('aria-label="Journal de l\'agent live"');
    expect(panel).toContain("La session continue de réessayer.");
    expect(panel).toContain('role="alert"');
    // Consentement explicite avant toute capture.
    expect(panel).toContain("les images capturées alimentent le moteur de vision interne de ma session");
    // Le moteur interne est nommé (transparence du périmètre).
    expect(panel).toContain("aucune clé API, aucun service externe");
  });

  it("zéro canal externe : le chat charge le panneau interne, plus aucune trace du client Gemini retiré", () => {
    // Le chat charge le panneau INTERNE en lazy (chunk séparé).
    expect(chat).toContain('import("@/components/live/live-interne-panel")');
    // Plus AUCUNE référence au panneau/client Gemini dans le code vivant.
    expect(chat).not.toContain("live-gemini-panel");
    expect(panel).not.toContain("gemini-live-client");
    expect(panel).not.toMatch(/generativelanguage|aiplatform|wss:\/\//);
    // Aucune clé stockée (l'ancien sessionStorage gen3ia-gemini-key est aboli).
    expect(panel).not.toContain("sessionStorage");
    expect(panel).not.toMatch(/https?:\/\//);
  });
});
