import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CHAÎNE DE DÉCISION DES MODES (Task 122) — Docker > serverless > simulation.
 *
 * Tests à mocks isolés (le moteur serverless et le client Docker sont
 * substitués) : on vérifie la DÉCISION, pas l'exécution (couverte par
 * serverless-exec.test.ts).
 */

const clientMocks = vi.hoisted(() => ({ executeSandbox: vi.fn() }));
vi.mock("./client", () => ({ executeSandbox: clientMocks.executeSandbox }));

const serverlessMocks = vi.hoisted(() => ({ run: vi.fn(), possible: vi.fn() }));
vi.mock("./serverless-exec", () => ({
  runServerlessExecution: serverlessMocks.run,
  isServerlessExecutionPossible: serverlessMocks.possible,
}));

import { currentTerminalEngine, runSandboxOrSimulation } from "./simulation";
import type { SandboxJob } from "./types";

function job(runtime: SandboxJob["runtime"], code: string): SandboxJob {
  return {
    executionId: "exec-modes",
    userId: "user-modes",
    runtime,
    code,
    limits: { timeoutMs: 2_000, memoryMb: 256, cpu: 1, maxOutputBytes: 100_000 },
    network: "none",
  };
}

const DOCKER_RESULT = { success: true, stdout: "docker", stderr: "", exitCode: 0, durationMs: 10 };
const SERVERLESS_RESULT = { success: true, stdout: "serverless", stderr: "", exitCode: 0, durationMs: 10, mode: "serverless" as const, timedOut: false, outputTruncated: false };

beforeEach(() => {
  clientMocks.executeSandbox.mockReset().mockResolvedValue(DOCKER_RESULT);
  serverlessMocks.run.mockReset().mockResolvedValue(SERVERLESS_RESULT);
  serverlessMocks.possible.mockReset().mockReturnValue(true);
  process.env.SANDBOX_URL = "";
  process.env.SANDBOX_SHARED_SECRET = "";
});

afterEach(() => {
  delete process.env.SANDBOX_URL;
  delete process.env.SANDBOX_SHARED_SECRET;
});

describe("chaîne de décision Docker > serverless > simulation", () => {
  it("Docker configuré et disponible → mode sandbox, serverless JAMAIS invoqué", async () => {
    process.env.SANDBOX_URL = "https://sandbox.internal";
    process.env.SANDBOX_SHARED_SECRET = "secret-partage-32-caracteres-minimum";

    const result = await runSandboxOrSimulation(job("node", "console.log(1)"));

    expect(result.mode).toBe("sandbox");
    expect(result.stdout).toBe("docker");
    expect(serverlessMocks.run).not.toHaveBeenCalled();
  });

  it("Docker configuré mais INDISPONIBLE → retombée EXÉCUTION RÉELLE serverless (cause annoncée)", async () => {
    process.env.SANDBOX_URL = "https://sandbox.internal";
    process.env.SANDBOX_SHARED_SECRET = "secret-partage-32-caracteres-minimum";
    clientMocks.executeSandbox.mockRejectedValue(new Error("fetch failed"));

    const result = await runSandboxOrSimulation(job("shell", "ls"));

    expect(result.mode).toBe("serverless");
    expect(serverlessMocks.run).toHaveBeenCalledTimes(1);
    expect(result.stderr).toContain("Docker indisponible");
    expect(result.stderr).toContain("fetch failed");
  });

  it("Docker indisponible ET runtime local absent → simulation annoncée (double cause)", async () => {
    process.env.SANDBOX_URL = "https://sandbox.internal";
    process.env.SANDBOX_SHARED_SECRET = "secret-partage-32-caracteres-minimum";
    clientMocks.executeSandbox.mockRejectedValue(new Error("fetch failed"));
    serverlessMocks.possible.mockReturnValue(false);

    const result = await runSandboxOrSimulation(job("python", "print(1)"));

    expect(result.mode).toBe("simulation");
    expect(serverlessMocks.run).not.toHaveBeenCalled();
    expect(result.stderr).toContain("repli simulation annoncée");
    expect(result.simulation?.engine).toBe("static-python");
  });

  it("sans Docker (nouveau DÉFAUT) → EXÉCUTION RÉELLE serverless", async () => {
    const result = await runSandboxOrSimulation(job("shell", "echo ok"));

    expect(result.mode).toBe("serverless");
    expect(serverlessMocks.run).toHaveBeenCalledTimes(1);
    expect(serverlessMocks.run).toHaveBeenCalledWith(expect.objectContaining({ runtime: "shell", code: "echo ok" }));
  });

  it("sans Docker et runtime local ABSENT (ex. python3 manquant) → simulation annoncée", async () => {
    serverlessMocks.possible.mockReturnValue(false);

    const result = await runSandboxOrSimulation(job("python", "print(1)"));

    expect(result.mode).toBe("simulation");
    expect(result.simulation?.engine).toBe("static-python");
    expect(serverlessMocks.run).not.toHaveBeenCalled();
  });

  it("currentTerminalEngine : docker | serverless | simulation selon l'environnement", () => {
    expect(currentTerminalEngine()).toBe("serverless");

    process.env.SANDBOX_URL = "https://sandbox.internal";
    process.env.SANDBOX_SHARED_SECRET = "secret-partage-32-caracteres-minimum";
    expect(currentTerminalEngine()).toBe("docker");

    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_SHARED_SECRET;
    serverlessMocks.possible.mockReturnValue(false);
    expect(currentTerminalEngine()).toBe("simulation");
  });
});
