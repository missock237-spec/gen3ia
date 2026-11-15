import { describe, expect, it } from "vitest";

import { createAgentPolicy } from "./agent-policy";
import { isToolAllowed } from "./execution-policy";

/**
 * Task 107 — « l'agent IA a accès à TOUS les outils » :
 * createAgentPolicy émet la sentinelle "*" pour standard/power/admin (la
 * sémantique "*" est traitée par isToolAllowed) et garde safe en lecture
 * seule explicite. La barrière FINE reste la couche permissions + flags +
 * HITL + caps persona (resolveAllowedTools côté personalized-plan).
 */
describe("createAgentPolicy — modèle whitelist Task 107 (« * » partout sauf safe)", () => {
  it("standard : sentinelle '*' + permissions élargies (tool.external, network.write)", () => {
    const policy = createAgentPolicy("standard");
    expect(policy.allowedTools).toEqual(["*"]);
    expect(policy.permissions).toContain("tool.external");
    expect(policy.permissions).toContain("network.write");
    // Les outils externes et médias passent désormais la couche whitelist.
    expect(isToolAllowed(policy, "email.send")).toBe(true);
    expect(isToolAllowed(policy, "image.generate")).toBe(true);
    expect(isToolAllowed(policy, "video.create")).toBe(true);
    expect(isToolAllowed(policy, "schedule.create")).toBe(true);
  });

  it("power : sentinelle '*' + permissions ads.* complétées (code.execute conservé)", () => {
    const policy = createAgentPolicy("power");
    expect(policy.allowedTools).toEqual(["*"]);
    expect(policy.permissions).toContain("ads.read");
    expect(policy.permissions).toContain("ads.write");
    expect(policy.permissions).toContain("code.execute");
    expect(policy.allowCodeExecution).toBe(true);
    expect(policy.allowExternalApps).toBe(true);
  });

  it("admin : sentinelle '*' + permissions ads.* présentes", () => {
    const policy = createAgentPolicy("admin");
    expect(policy.allowedTools).toEqual(["*"]);
    expect(policy.permissions).toContain("ads.read");
    expect(policy.permissions).toContain("ads.write");
    expect(policy.allowFileDelete).toBe(true);
  });

  it("safe : AUCUNE sentinelle — lecture seule par design", () => {
    const policy = createAgentPolicy("safe");
    expect(policy.allowedTools).toEqual([]);
    expect(policy.allowedTools).not.toContain("*");
    expect(policy.permissions).toEqual(["tool.read", "file.read"]);
    expect(isToolAllowed(policy, "email.send")).toBe(false);
  });
});
