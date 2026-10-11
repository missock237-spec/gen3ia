import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OUTIL AGENT terminal.run (Task 122) : le catalogue d'outils fournit ENFIN
 * un terminal EXÉCUTABLE à l'agent IA. Vérifié ici :
 *  - exécution via la MÊME chaîne sécurisée que le terminal agent ;
 *  - session arrêtée par l'utilisateur → refus ;
 *  - journal d'audit (sessions terminal) alimenté en fail-soft ;
 *  - limites/deny-list héritées d'executeAgentTerminal (contrat partagé).
 */

const terminalMocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/agents/runtime/agent-terminal", () => ({
  executeAgentTerminal: terminalMocks.execute,
}));

const sessionMocks = vi.hoisted(() => ({
  isActive: vi.fn(),
  record: vi.fn(),
}));
vi.mock("@/lib/agents/runtime/terminal-sessions", () => ({
  isTerminalSessionActive: sessionMocks.isActive,
  recordTerminalExecution: sessionMocks.record,
}));

import { createDefaultToolRegistry } from "../default-registry";
import { terminalRunTool } from "./run";

function executionResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    stdout: "v22.0.0\n",
    stderr: "",
    exitCode: 0,
    durationMs: 42,
    mode: "serverless",
    timedOut: false,
    outputTruncated: false,
    ...overrides,
  };
}

beforeEach(() => {
  terminalMocks.execute.mockReset().mockResolvedValue(executionResult());
  sessionMocks.isActive.mockReset().mockResolvedValue(true);
  sessionMocks.record.mockReset().mockResolvedValue(null);
});

describe("outil terminal.run", () => {
  it("est ENREGISTRÉ au registre d'outils par défaut (catalogue agents)", () => {
    const registry = createDefaultToolRegistry();
    expect(registry.has("terminal.run")).toBe(true);
    const tool = registry.get("terminal.run");
    expect(tool?.category).toBe("code");
    expect(tool?.risk).toBe("medium");
  });

  it("exécute la commande via executeAgentTerminal (chaîne sécurisée partagée) et renvoie le résultat + mode", async () => {
    const result = await terminalRunTool.execute(
      { command: "node --version", timeoutMs: 5_000, memoryMb: 256 },
      { userId: "u1", executionId: "exec-1", projectId: "p1" },
    );

    expect(terminalMocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      executionId: "exec-1",
      command: "node --version",
      timeoutMs: 5_000,
      memoryMb: 256,
    }));
    expect(result).toEqual(executionResult());
    expect((result as { mode: string }).mode).toBe("serverless");
  });

  it("journalise l'exécution dans la session terminal (audit + flux IDE), en fail-soft", async () => {
    sessionMocks.record.mockRejectedValue(new Error("Firestore down"));
    const result = await terminalRunTool.execute(
      { command: "ls", terminalSessionId: "sess-1", conversationId: "conv-9" },
      { userId: "u1", executionId: "exec-2" },
    );

    expect(sessionMocks.record).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      sessionId: "sess-1",
      conversationId: "conv-9",
      command: "ls",
      success: true,
      mode: "serverless",
    }));
    // L'échec d'audit n'interrompt JAMAIS l'agent : le résultat est rendu.
    expect((result as { stdout: string }).stdout).toContain("v22.0.0");
  });

  it("session terminal ARRÊTÉE par l'utilisateur → refus net, aucune exécution", async () => {
    sessionMocks.isActive.mockResolvedValue(false);

    await expect(
      terminalRunTool.execute({ command: "ls", terminalSessionId: "sess-stop" }, { userId: "u1", executionId: "exec-3" }),
    ).rejects.toThrow("arrêtée par l'utilisateur");

    expect(terminalMocks.execute).not.toHaveBeenCalled();
    expect(sessionMocks.record).not.toHaveBeenCalled();
  });

  it("commande refusée par la politique partagée → l'erreur remonte à l'agent (aucune exécution)", async () => {
    terminalMocks.execute.mockRejectedValue(new Error("Terminal command rejected by Gen3ia safety policy. (motif : élévation de privilèges (sudo/su))"));

    await expect(
      terminalRunTool.execute({ command: "sudo rm -rf /" }, { userId: "u1", executionId: "exec-4" }),
    ).rejects.toThrow("safety policy");
  });

  it("schéma d'entrée : commande obligatoire, bornes de limites", async () => {
    await expect(
      terminalRunTool.execute({ command: "" }, { userId: "u1", executionId: "e" }),
    ).rejects.toThrow();
    await expect(
      terminalRunTool.execute({ command: "ls", timeoutMs: 999_999 } as never, { userId: "u1", executionId: "e" }),
    ).rejects.toThrow();
  });
});
