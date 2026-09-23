import { describe, expect, it } from "vitest";

import { isImmersiveChatRoute } from "./chat-surface";

/**
 * Les surfaces de chat (conversation + chat d'agent IA) doivent déclencher
 * le mode immersif : interface de discussion sur toute la hauteur de
 * l'appareil, sans navigation ni marges.
 */
describe("isImmersiveChatRoute", () => {
  it("active le mode immersif sur les surfaces de chat", () => {
    expect(isImmersiveChatRoute("/workspace/conversations")).toBe(true);
    expect(isImmersiveChatRoute("/workspace/conversations/abc123")).toBe(true);
    expect(isImmersiveChatRoute("/studio/agents")).toBe(true);
  });

  it("reste en mise en page classique partout ailleurs", () => {
    expect(isImmersiveChatRoute("/")).toBe(false);
    expect(isImmersiveChatRoute("/workspace")).toBe(false);
    expect(isImmersiveChatRoute("/workspace/files")).toBe(false);
    expect(isImmersiveChatRoute("/workspace/projects/p1")).toBe(false);
    expect(isImmersiveChatRoute("/studio")).toBe(false);
    expect(isImmersiveChatRoute("/studio/agents-suite")).toBe(false);
    expect(isImmersiveChatRoute("/studio/connections")).toBe(false);
  });

  it("ignore les segments parasites après l'identifiant de conversation", () => {
    expect(isImmersiveChatRoute("/workspace/conversations/abc/extra")).toBe(false);
  });
});
