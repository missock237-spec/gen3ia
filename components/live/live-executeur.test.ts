import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * AGENT LIVE — EXÉCUTEUR NAVIGATEUR UNIQUE (it.53 : « un seul exécuteur,
 * deux surfaces ») — conventions du dépôt : vitest tourne en Node SANS
 * jsdom ni @testing-library/react. L'exécution navigateur du live interne
 * (components/live/live-executeur.tsx) est verrouillée structurellement :
 *
 *  1. LES PORTES INTERNES SONT CONSOMMÉES : POST /start (armement),
 *     POST frames (images → décisions du moteur de vision interne),
 *     PUT frames (résultat d'action), approve (HITL), stop (arrêt réel).
 *  2. LES SOURCES DE CAPTURE SONT HONNÊTES : écran PC (getDisplayMedia)
 *     OU caméra mobile (getUserMedia, avant/arrière) — le picker est
 *     explicite, le fallback est annoncé.
 *  3. LA BOUCLE EST ROBUSTE : jeton de génération anti-course
 *     (reactStrictMode double le montage), garde sendingRef, arrêt
 *     propre sur les codes terminaux de la porte (LIVE_STOPPED,
 *     LIVE_EXPIRED, LIVE_FAILED, LIVE_DEVICE_MISMATCH — plus AUCUNE
 *     boucle qui réessaie indéfiniment sur une session morte), échecs
 *     réseau consécutifs visibles, nettoyage des tracks au démontage.
 *  4. ZÉRO CANAL EXTERNE : aucune clé API, aucun service tiers, aucune
 *     référence au client « Gemini Live » retiré.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const EXECUTEUR = "components/live/live-executeur.tsx";

describe("Agent live — exécuteur navigateur unique (câblage it.53)", () => {
  const executeur = read(EXECUTEUR);

  it("les portes internes sont consommées dans leurs cinq modes (start, frames, résultat, approbation, arrêt)", () => {
    // POST /start — armement (deviceId).
    expect(executeur).toContain("`/api/live/sessions/${sessionId}/start`");
    // POST frames — images → décisions du moteur interne.
    expect(executeur).toContain("`/api/live/sessions/${sessionId}/frames`");
    expect(executeur).toContain('method: "POST"');
    // PUT frames — résultat d'action (ok / échec honnête).
    expect(executeur).toContain('method: "PUT"');
    // POST approve — HITL (carte inline).
    expect(executeur).toContain("/actions/${pendingApproval.actionId}/approve`");
    // POST stop — arrêt réel de la session.
    expect(executeur).toContain('body: JSON.stringify({ action: "stop" })');
  });

  it("les sources de capture sont honnêtes : écran PC (getDisplayMedia) ou caméra mobile (getUserMedia, avant/arrière)", () => {
    expect(executeur).toContain("navigator.mediaDevices.getDisplayMedia");
    expect(executeur).toContain("navigator.mediaDevices.getUserMedia");
    expect(executeur).toContain("facingMode: facingRef.current");
    // Le picker d'arrêt est explicite et accessible (aria-pressed).
    expect(executeur).toContain('aria-pressed={sourceActuelle === "screen"}');
    expect(executeur).toContain('aria-pressed={sourceActuelle === "camera"}');
    expect(executeur).toContain("Relancer la capture");
    expect(executeur).toContain('cameraFacing === "environment" ? "arrière" : "avant"');
    // Le fallback est annoncé (pas de message d'erreur brut).
    expect(executeur).toContain("Partage d'écran indisponible dans ce navigateur");
    expect(executeur).toContain("Caméra indisponible dans ce navigateur");
  });

  it("la boucle est robuste : anti-course, codes terminaux, échecs visibles, nettoyage, honnêteté", () => {
    // Anti-course StrictMode + réponse périmée jamais appliquée.
    expect(executeur).toContain("generationRef.current += 1");
    expect(executeur).toContain("generation !== generationRef.current");
    // Une seule frame en vol à la fois ; onglet masqué = pas de capture.
    expect(executeur).toContain("sendingRef.current");
    expect(executeur).toContain('document.visibilityState !== "visible"');
    // Codes terminaux de la porte : la boucle s'arrête au lieu de boucler.
    expect(executeur).toContain("LIVE_STOPPED");
    expect(executeur).toContain("LIVE_EXPIRED");
    expect(executeur).toContain("LIVE_FAILED");
    expect(executeur).toContain("LIVE_DEVICE_MISMATCH");
    // Limites navigateur honnêtes (l'agent observe et décrit).
    expect(executeur).toContain("Action réservée à un client PC : en mode navigateur, l'agent observe et décrit");
    // HITL inline + journal visible, jamais avalé.
    expect(executeur).toContain("Action sensible en attente de votre validation");
    expect(executeur).toContain('role="status"');
    expect(executeur).toContain('role="alert"');
    expect(executeur).toContain("aria-label=\"Journal de l'agent live\"");
    expect(executeur).toContain("La session continue de réessayer.");
    // Nettoyage : les tracks sont arrêtés au démontage.
    expect(executeur).toContain("getTracks().forEach((track) => track.stop())");
    // Le moteur interne est nommé (transparence du périmètre).
    expect(executeur).toContain("Moteur de vision INTERNE gen3");
  });

  it("zéro canal externe : aucune clé, aucun service tiers, aucune trace du client Gemini retiré", () => {
    expect(executeur).not.toContain("gemini-live-client");
    expect(executeur).not.toMatch(/generativelanguage|aiplatform|wss:\/\//);
    // Aucune clé stockée, aucune URL absolue externe.
    expect(executeur).not.toContain("sessionStorage");
    expect(executeur).not.toMatch(/https?:\/\//);
  });
});
