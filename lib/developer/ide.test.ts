import { describe, expect, it } from "vitest";

import { extractTestRuns, monacoLanguageFor, parseErrorRefs } from "./ide";
import type { TerminalEntry } from "@/lib/agents/runtime/terminal-sessions";

function entry(partial: Partial<TerminalEntry> & { index: number }): TerminalEntry {
  return {
    command: "node script.js",
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 12,
    mode: "simulation",
    engine: null,
    success: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("parseErrorRefs", () => {
  it("extrait les références fichier:ligne:colonne style Node", () => {
    const refs = parseErrorRefs("    at Object.<anonymous> (/workspace/app.js:42:7)");
    expect(refs).toHaveLength(1);
    expect(refs[0].path).toBe("/workspace/app.js");
    expect(refs[0].line).toBe(42);
    expect(refs[0].column).toBe(7);
  });

  it("extrait les références Python (File \"x.py\", line N)", () => {
    const refs = parseErrorRefs('Traceback:\n  File "main.py", line 13, in <module>');
    expect(refs).toHaveLength(1);
    expect(refs[0].path).toBe("main.py");
    expect(refs[0].line).toBe(13);
  });

  it("déduplique et plafonne le nombre de références", () => {
    const line = "error in src/a.ts:1:1 and src/a.ts:1:1";
    const refs = parseErrorRefs(line);
    expect(refs).toHaveLength(1);
  });

  it("retourne une liste vide pour une sortie sans référence ou vide", () => {
    expect(parseErrorRefs("tout va bien")).toEqual([]);
    expect(parseErrorRefs(undefined)).toEqual([]);
  });
});

describe("extractTestRuns", () => {
  it("identifie une commande de test réussie avec résumé", () => {
    const runs = extractTestRuns([
      entry({ index: 0, command: "npm test", stdout: "Tests: 12 passed, 12 total\n", exitCode: 0 }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].passed).toBe(true);
    expect(runs[0].summary).toContain("12 réussis");
  });

  it("identifie un échec de tests", () => {
    const runs = extractTestRuns([
      entry({ index: 1, command: "npx vitest run", stdout: "2 failed | 10 passed", exitCode: 1, success: false }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].passed).toBe(false);
  });

  it("ignore les commandes qui ne sont pas des tests", () => {
    const runs = extractTestRuns([entry({ index: 2, command: "ls -la", stdout: "src" })]);
    expect(runs).toHaveLength(0);
  });

  it("plafonne l'historique à 50 résultats", () => {
    const many = Array.from({ length: 60 }, (_, i) => entry({ index: i, command: "npm test", stdout: "1 passed", exitCode: 0 }));
    expect(extractTestRuns(many).length).toBeLessThanOrEqual(50);
  });
});

describe("monacoLanguageFor", () => {
  it("détecte les langages courants", () => {
    expect(monacoLanguageFor("app.tsx")).toBe("typescript");
    expect(monacoLanguageFor("script.js")).toBe("javascript");
    expect(monacoLanguageFor("main.py")).toBe("python");
    expect(monacoLanguageFor("page.html")).toBe("html");
    expect(monacoLanguageFor("data.json")).toBe("json");
    expect(monacoLanguageFor("inconnu.xyz")).toBe("plaintext");
  });

  it("accepte un nom de langage direct", () => {
    expect(monacoLanguageFor("typescript")).toBe("typescript");
    expect(monacoLanguageFor("python")).toBe("python");
  });
});
