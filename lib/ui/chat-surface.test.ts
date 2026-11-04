import { describe, expect, it } from "vitest";

import { isImmersiveChatRoute } from "./chat-surface";

/**
 * Les surfaces de chat (accueil /, Nova /chat, /dashboard, copilote)
 * doivent déclencher le mode immersif : interface de discussion sur toute
 * la hauteur de l'appareil, sans navigation ni marges.
 *
 * Repositionnement « plateforme IA » (2026-11-05, style Gemini) : la
 * racine / est désormais LE chat — et /dashboard, alias historique, suit
 * le même régime (une seule barre latérale, celle de NovaChat).
 */
describe("isImmersiveChatRoute", () => {
  it("active le mode immersif sur les surfaces de chat", () => {
    expect(isImmersiveChatRoute("/")).toBe(true);
    expect(isImmersiveChatRoute("/chat")).toBe(true);
    expect(isImmersiveChatRoute("/dashboard")).toBe(true);
    expect(isImmersiveChatRoute("/copilot")).toBe(true);
  });

  it("reste en mise en page classique partout ailleurs", () => {
    expect(isImmersiveChatRoute("/settings")).toBe(false);
    expect(isImmersiveChatRoute("/vitrine")).toBe(false);
    // Surfaces workspace/studio supprimées (redirigées vers /dashboard).
    expect(isImmersiveChatRoute("/workspace")).toBe(false);
    expect(isImmersiveChatRoute("/workspace/conversations")).toBe(false);
    expect(isImmersiveChatRoute("/studio")).toBe(false);
  });
});
