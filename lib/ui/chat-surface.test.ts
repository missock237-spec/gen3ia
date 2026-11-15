import { describe, expect, it } from "vitest";

import { isImmersiveChatRoute } from "./chat-surface";

/**
 * Les surfaces de chat (Nova /chat, copilote) doivent déclencher le
 * mode immersif : interface de discussion sur toute la hauteur de
 * l'appareil, sans navigation ni marges.
 */
describe("isImmersiveChatRoute", () => {
  it("active le mode immersif sur les surfaces de chat", () => {
    expect(isImmersiveChatRoute("/chat")).toBe(true);
    expect(isImmersiveChatRoute("/copilot")).toBe(true);
  });

  it("reste en mise en page classique partout ailleurs", () => {
    expect(isImmersiveChatRoute("/")).toBe(false);
    expect(isImmersiveChatRoute("/dashboard")).toBe(false);
    expect(isImmersiveChatRoute("/settings")).toBe(false);
    // Surfaces workspace/studio supprimées (redirigées vers /dashboard).
    expect(isImmersiveChatRoute("/workspace")).toBe(false);
    expect(isImmersiveChatRoute("/workspace/conversations")).toBe(false);
    expect(isImmersiveChatRoute("/studio")).toBe(false);
  });
});
