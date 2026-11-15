import { describe, expect, it } from "vitest";
import { authorizeTool } from "./tool-permissions";
import { createAgentPolicy } from "./agent-policy";

/**
 * Task 107 : la whitelist standard est désormais la sentinelle "*" — la
 * barrière FINE est la couche permissions + flags (authorizeTool). L'ancien
 * test « keeps ZIP creation out of standard agents » (filtre whitelist) n'a
 * plus de sens : zip.create passe les permissions standard (tool.write +
 * file.write + allowFileWrite). Les refus fins ci-dessous préservent
 * l'intention d'origine : le standard reste bloqué sur le destructif, le code
 * et les applications externes.
 */
describe("agent tool permissions", () => {
  it("allows standard agents to create files", () => {
    const policy = createAgentPolicy("standard");
    expect(() => authorizeTool(policy, "file.create")).not.toThrow();
  });

  it("keeps destructive file deletion out of standard agents (permissions fines)", () => {
    const policy = createAgentPolicy("standard");
    expect(() => authorizeTool(policy, "file.delete")).toThrow();
  });

  it("keeps external application tools out of standard agents (allowExternalApps)", () => {
    const policy = createAgentPolicy("standard");
    expect(() => authorizeTool(policy, "mcp.call")).toThrow();
  });

  it("allows standard agents to send emails (tool.external + network.write, Task 107)", () => {
    const policy = createAgentPolicy("standard");
    expect(() => authorizeTool(policy, "email.send")).not.toThrow();
  });

  it("allows power agents to create and analyze ZIP artifacts", () => {
    const policy = createAgentPolicy("power");
    expect(() => authorizeTool(policy, "zip.create")).not.toThrow();
    expect(() => authorizeTool(policy, "zip.analyze")).not.toThrow();
    expect(() => authorizeTool(policy, "artifact.create")).not.toThrow();
  });

  it("keeps code execution disabled for standard agents", () => {
    const policy = createAgentPolicy("standard");
    expect(() => authorizeTool(policy, "code.execute")).toThrow();
  });
});
