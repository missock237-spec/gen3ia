import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * AGENT LIVE — MOTEUR INTERNE GEN3 SOUS LE CHAT IA (it.52, demande
 * propriétaire : « activation depuis le chat IA, live en interne avec
 * gen3 » ; it.53 : « un seul exécuteur, deux surfaces ») — conventions
 * du dépôt : vitest tourne en Node SANS jsdom ni @testing-library/react.
 * Le panneau du chat est verrouillé structurellement :
 *
 *  1. L'ACTIVATION EST RÉELLE : POST /api/live/sessions (création réelle
 *     en mode navigateur), consentement explicite, objectif ≥ 10
 *     caractères, permissions sélectionnables, 401 → connexion.
 *  2. L'EXÉCUTION EST DÉLÉGUÉE À L'EXÉCUTEUR UNIQUE : dès la session
 *     créée, le panneau rende la main à components/live/live-executeur
 *     (le même que /live) — il ne garde AUCUNE boucle de capture
 *     (zéro getDisplayMedia, zéro frames, zéro setInterval en copie).
 *  3. L'HONNÊTETÉ EST CONSERVÉE : carte de connexion, rôle alert sur
 *     l'erreur d'activation, moteur interne nommé (aucune clé API,
 *     aucun service externe).
 *  4. ZÉRO CANAL EXTERNE : le chat charge ce panneau en lazy, aucune
 *     référence au client « Gemini Live » retiré (it.52).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const PANEL = "components/live/live-interne-panel.tsx";
const CHAT = "components/chat/nova-chat.tsx";

describe("Agent live — carte d'activation du chat (câblage it.52 + it.53)", () => {
  const panel = read(PANEL);
  const chat = read(CHAT);

  it("l'activation est réelle : POST /api/live/sessions en mode navigateur, consentement, 401 honnête", () => {
    // POST — création RÉELLE de la session (mode navigateur).
    expect(panel).toContain('authFetch("/api/live/sessions", {');
    expect(panel).toContain('mode: "browser"');
    // Objectif ≥ 10 caractères, permissions non vides, consentement requis.
    expect(panel).toContain("objectif.trim().length < 10");
    expect(panel).toContain("permissions.length === 0");
    expect(panel).toContain("consentement");
    // Honnêteté : 401 → message de connexion (carte + activation).
    expect(panel).toContain("Connectez-vous pour activer l&apos;agent live ici, dans le chat.");
    expect(panel).toContain('"Connectez-vous pour activer l\'agent live."');
    // Erreur d'activation signalée (role=alert) + 429 restitué.
    expect(panel).toContain('role="alert"');
    expect(panel).toContain("Trop de sessions créées rapprochées");
    // Les sources de capture sont choisies AVANT l'activation (bascule
    // explicite, accessible).
    expect(panel).toContain('aria-pressed={source === "screen"}');
    expect(panel).toContain('aria-pressed={source === "camera"}');
    // Consentement explicite avant toute capture.
    expect(panel).toContain("les images capturées alimentent le moteur de vision interne de ma session");
    // Le moteur interne est nommé (transparence du périmètre).
    expect(panel).toContain("aucune clé API, aucun service externe");
  });

  it("l'exécution est déléguée à l'exécuteur unique — plus AUCUNE boucle de capture en copie", () => {
    // Le panneau importe et rend l'exécuteur partagé (le même que /live).
    expect(panel).toContain('import { LiveExecuteur } from "@/components/live/live-executeur"');
    expect(panel).toContain("<LiveExecuteur");
    expect(panel).toContain("sessionId={sessionIdActif}");
    expect(panel).toContain("sourceInitiale={source}");
    expect(panel).toContain("cameraFacingInitiale={cameraFacing}");
    expect(panel).toContain("onFermer={() => setSessionIdActif(null)}");
    // La copie locale de la boucle est bien SUPPRIMÉE (it.53).
    expect(panel).not.toContain("getDisplayMedia");
    expect(panel).not.toContain("getUserMedia");
    expect(panel).not.toContain("/frames`");
    expect(panel).not.toContain("setInterval");
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
