import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TERMINAL UTILISATEUR : exécution directe dans le workspace personnel.
 * Workspace réutilisé/créé selon la propriété (assertWorkspaceOwner),
 * session scope `workspace:<id>`, journal d'exécution (exit/mode/moteur),
 * refus de commande dangereuse propagé ET journalisé.
 */

const workspaceMocks = vi.hoisted(() => ({
  createExecutionWorkspace: vi.fn(),
  registerWorkspace: vi.fn(),
  assertWorkspaceOwner: vi.fn(),
}));
vi.mock("@/lib/execution/workspace", () => ({
  createExecutionWorkspace: workspaceMocks.createExecutionWorkspace,
  workspaceRootFor: (id: string) => `/tmp/gen3ia-ws-${id}`,
}));
vi.mock("@/lib/execution/workspace-registry", () => ({
  registerWorkspace: workspaceMocks.registerWorkspace,
  assertWorkspaceOwner: workspaceMocks.assertWorkspaceOwner,
}));

const terminalMocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));
vi.mock("@/lib/sandbox/simulation", () => ({
  runSandboxOrSimulation: (...args: unknown[]) => terminalMocks.execute(...args),
}));

const sessionMocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  record: vi.fn(),
}));
vi.mock("./terminal-sessions", () => ({
  ensureTerminalSession: (...args: unknown[]) => sessionMocks.ensure(...args),
  recordTerminalExecution: (...args: unknown[]) => sessionMocks.record(...args),
}));

import { executeUserTerminalCommand } from "./user-terminal";

function executionResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    success: true,
    stdout: "v22.0.0\n",
    stderr: "",
    exitCode: 0,
    durationMs: 42,
    mode: "simulation" as const,
    simulation: { engine: "static-shell" as const, trace: ["echo node --version"], warnings: [] },
    ...overrides,
  };
}

beforeEach(() => {
  workspaceMocks.createExecutionWorkspace.mockReset().mockResolvedValue({ id: "ws-hash", root: "/tmp/gen3ia-ws-ws-hash" });
  workspaceMocks.registerWorkspace.mockReset().mockResolvedValue(undefined);
  workspaceMocks.assertWorkspaceOwner.mockReset().mockResolvedValue({ id: "ws-owned", ownerId: "u1" });
  terminalMocks.execute.mockReset().mockResolvedValue(executionResult());
  sessionMocks.ensure.mockReset().mockResolvedValue({ id: "sess-1", userId: "u1", title: "Terminal · workspace", status: "active", commandCount: 0 });
  sessionMocks.record.mockReset().mockResolvedValue(null);
});

describe("executeUserTerminalCommand", () => {
  it("crée le workspace personnel (id stable) + session workspace + journal complet", async () => {
    const result = await executeUserTerminalCommand({ userId: "u1", command: "node --version" });

    expect(workspaceMocks.createExecutionWorkspace).toHaveBeenCalledWith("user-terminal:u1");
    expect(workspaceMocks.registerWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws-hash" }),
      "u1",
      "user-terminal:u1",
    );
    expect(sessionMocks.ensure).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", workspaceId: "ws-hash" }));
    expect(sessionMocks.record).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      workspaceId: "ws-hash",
      sessionId: "sess-1",
      command: "node --version",
      success: true,
      exitCode: 0,
      mode: "simulation",
      engine: "static-shell",
    }));
    expect(result.workspace).toEqual({ id: "ws-hash", reused: false });
    expect(result.execution.exitCode).toBe(0);
  });

  it("workspaceId fourni → réutilisation PROPRIÉTAIRE seule (étranger refusé, rien d'exécuté)", async () => {
    const result = await executeUserTerminalCommand({ userId: "u1", command: "ls", workspaceId: "ws-owned" });
    expect(workspaceMocks.assertWorkspaceOwner).toHaveBeenCalledWith("ws-owned", "u1");
    expect(workspaceMocks.createExecutionWorkspace).not.toHaveBeenCalled();
    expect(result.workspace).toEqual({ id: "ws-owned", reused: true });

    workspaceMocks.assertWorkspaceOwner.mockRejectedValue(new Error("Workspace access denied"));
    await expect(executeUserTerminalCommand({ userId: "attacker", command: "ls", workspaceId: "ws-owned" }))
      .rejects.toThrow("Workspace access denied");
    expect(terminalMocks.execute).toHaveBeenCalledTimes(1); // la première seule
  });

  it("commande dangereuse refusée par la politique → propagée ET journalisée en échec", async () => {
    terminalMocks.execute.mockRejectedValue(new Error("Terminal command rejected by Gen3ia safety policy."));

    await expect(executeUserTerminalCommand({ userId: "u1", command: "sudo rm -rf /" }))
      .rejects.toThrow("safety policy");

    expect(sessionMocks.record).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: expect.stringContaining("safety policy"),
    }));
  });

  it("commande vide refusée sans aucun effet de bord", async () => {
    await expect(executeUserTerminalCommand({ userId: "u1", command: "   " })).rejects.toThrow("Commande vide");
    expect(workspaceMocks.createExecutionWorkspace).not.toHaveBeenCalled();
    expect(terminalMocks.execute).not.toHaveBeenCalled();
  });

  it("exitCode non nul → journalisé en échec honnête", async () => {
    terminalMocks.execute.mockResolvedValue(executionResult({ exitCode: 2, success: false, stdout: "", stderr: "no such file" }));

    const result = await executeUserTerminalCommand({ userId: "u1", command: "cat missing.txt" });
    expect(sessionMocks.record).toHaveBeenCalledWith(expect.objectContaining({ success: false, exitCode: 2, stderr: "no such file" }));
    expect(result.execution.exitCode).toBe(2);
  });
});
