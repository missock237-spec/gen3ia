import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Outil agent « terminal.shield » — Terminal Daemon Shield & Sandbox (Task 140).
 *
 * Verrous :
 *  1. succès direct : UNE seule exécution, aucun correctif, aucune sonde ;
 *  2. pré-vol : sonde d'existence COMBINÉE (motifs FOUND/MISSING + chemins
 *     cités), localisation find bornée, correction de chemin uniquement si
 *     UN SEUL candidat du même nom de base (tentative corrigée marquée
 *     fixApplied « path_correction ») ;
 *  3. alias de commande (python→python3, http→curl) en relance bornée ;
 *  4. dépendance npm manquante → commande COMBINÉE install+relance en UNE
 *     invocation (espace de travail éphémère) ; module relatif = bug de
 *     code, AUCUNE « réparation » inventée ;
 *  5. permission refusée → chmod +x combiné ;
 *  6. maxAutoFixes=0 → aucune relance, échec honnête ;
 *  7. sonde en échec (rejetée ou en erreur) → non fatale ;
 *  8. localisation ambiguë → pas de correction à l'aveugle.
 *
 * Frontière mockée : executeAgentTerminal (canal sécurisé réel — deny-list,
 * limites) ; le routage des réponses se fait sur le CONTENU de la commande.
 */

const executeAgentTerminalMock = vi.fn();
vi.mock("@/lib/agents/runtime/agent-terminal", () => ({
  executeAgentTerminal: (...args: unknown[]) => executeAgentTerminalMock(...args),
}));

import { extractPathTokens, terminalShieldTool } from "./terminal-shield";

interface ExecOutput {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  mode: string;
}

function exec(partial: Partial<ExecOutput> = {}): ExecOutput {
  return {
    success: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 12,
    mode: "serverless",
    ...partial,
  };
}

const CONTEXT = { userId: "user-1", executionId: "exec-shield-1" };

const isProbe = (command: string) =>
  command.includes("printf 'FOUND") && command.includes("printf 'MISSING");
const isLocate = (command: string) => command.startsWith("find /");

type Route = { match: (command: string) => boolean; result: () => ExecOutput };

function routeExec(routes: Route[], fallback: () => ExecOutput = () => exec()) {
  executeAgentTerminalMock.mockImplementation(async (params: { command: string }) => {
    for (const route of routes) {
      if (route.match(params.command)) return route.result();
    }
    return fallback();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("terminal.shield — extraction des tokens chemin (déterministe)", () => {
  it("retient les mots et chaînes citées contenant un slash, ignore URLs, /tmp, options et affectations", () => {
    const tokens = extractPathTokens(
      "curl -o out.json https://api.example.com/x --config=/app/cfg.json && cat './data/file.txt' /tmp/scratch",
    );
    expect(tokens).toEqual(["./data/file.txt"]);
  });

  it("plafonne à 10 tokens", () => {
    const command = Array.from({ length: 15 }, (_, i) => `dir${i}/file.txt`).join(" ");
    expect(extractPathTokens(command)).toHaveLength(10);
  });
});

describe("terminal.shield — exécution surveillée", () => {
  it("succès au premier essai : une seule exécution, aucun correctif, aucune sonde", async () => {
    routeExec([]);

    const result = await terminalShieldTool.execute({ command: "npm run build" }, CONTEXT);

    expect(executeAgentTerminalMock).toHaveBeenCalledTimes(1);
    expect(executeAgentTerminalMock.mock.calls[0][0]).toMatchObject({
      userId: "user-1",
      executionId: "exec-shield-1",
      command: "npm run build",
    });
    expect(result).toEqual({
      attempts: [
        {
          command: "npm run build",
          exitCode: 0,
          mode: "serverless",
          success: true,
          stderrExcerpt: "",
        },
      ],
      finalExitCode: 0,
      fixed: true,
      mode: "serverless",
    });
  });

  it("pré-vol : sonde combinée FOUND/MISSING, localisation find, correction du chemin erroné en une tentative", async () => {
    routeExec([
      { match: isProbe, result: () => exec({ stdout: "MISSING ./src/app.ts\n" }) },
      { match: isLocate, result: () => exec({ stdout: "/workspace/src/app.ts\n" }) },
    ]);

    const result = await terminalShieldTool.execute({ command: "cat ./src/app.ts" }, CONTEXT);

    // 1) sonde combinée — motifs FOUND/MISSING + chemin échappé en simple quotes.
    expect(executeAgentTerminalMock).toHaveBeenCalledTimes(3);
    const probeCommand = executeAgentTerminalMock.mock.calls[0][0].command as string;
    expect(probeCommand).toContain("printf 'FOUND");
    expect(probeCommand).toContain("printf 'MISSING");
    expect(probeCommand).toContain("'./src/app.ts'");
    // 2) localisation bornée par le nom de base.
    const locateCommand = executeAgentTerminalMock.mock.calls[1][0].command as string;
    expect(locateCommand.startsWith("find / -maxdepth 5 -name 'app.ts'")).toBe(true);
    expect(locateCommand).toContain("| head -3");
    // 3) exécution de la commande corrigée (chemin trouvé, cité).
    expect(executeAgentTerminalMock.mock.calls[2][0].command).toBe("cat '/workspace/src/app.ts'");

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].fixApplied).toMatchObject({ type: "path_correction" });
    expect(result.attempts[0].fixApplied?.description).toContain("./src/app.ts");
    expect(result.attempts[0].fixApplied?.description).toContain("/workspace/src/app.ts");
    expect(result.fixed).toBe(true);
    expect(result.finalExitCode).toBe(0);
  });

  it("localisation ambiguë (plusieurs candidats) : AUCUNE correction à l'aveugle, échec rapporté honnêtement", async () => {
    routeExec([
      { match: isProbe, result: () => exec({ stdout: "MISSING ./src/app.ts\n" }) },
      {
        match: isLocate,
        result: () => exec({ stdout: "/workspace/src/app.ts\n/workspace/other/app.ts\n" }),
      },
      {
        match: () => true,
        result: () =>
          exec({
            success: false,
            stderr: "cat: ./src/app.ts: No such file or directory",
            exitCode: 1,
          }),
      },
    ]);

    const result = await terminalShieldTool.execute({ command: "cat ./src/app.ts" }, CONTEXT);

    expect(executeAgentTerminalMock).toHaveBeenCalledTimes(3);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].command).toBe("cat ./src/app.ts");
    expect(result.attempts[0].fixApplied).toBeUndefined();
    expect(result.fixed).toBe(false);
    expect(result.finalExitCode).toBe(1);
  });

  it("commande introuvable « python » → relance avec « python3 » (correctif enregistré)", async () => {
    const mainResults = [
      exec({
        success: false,
        stderr: "bash: line 1: python: command not found",
        exitCode: 127,
      }),
      exec({ stdout: "3.12.1" }),
    ];
    routeExec([], () => mainResults.shift() ?? exec());

    const result = await terminalShieldTool.execute({ command: "python script.py" }, CONTEXT);

    expect(executeAgentTerminalMock).toHaveBeenCalledTimes(2);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].command).toBe("python script.py");
    expect(result.attempts[0].fixApplied).toBeUndefined();
    expect(result.attempts[1].command).toBe("python3 script.py");
    expect(result.attempts[1].fixApplied).toMatchObject({ type: "command_alias" });
    expect(result.fixed).toBe(true);
  });

  it("forme POSIX « sh: 1: http: not found » → alias http→curl", async () => {
    const mainResults = [
      exec({ success: false, stderr: "/bin/sh: 1: http: not found", exitCode: 127 }),
      exec({ stdout: "200 OK" }),
    ];
    routeExec([], () => mainResults.shift() ?? exec());

    const result = await terminalShieldTool.execute({ command: "http --version" }, CONTEXT);

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[1].command).toBe("curl --version");
    expect(result.attempts[1].fixApplied?.type).toBe("command_alias");
    expect(result.fixed).toBe(true);
  });

  it("dépendance npm manquante → installation puis relance COMBINÉES en une seule invocation", async () => {
    const mainResults = [
      exec({
        success: false,
        stderr: "node:internal/modules/cjs/loader:1143\nError: Cannot find module 'lodash'",
        exitCode: 1,
      }),
      exec({ stdout: "42" }),
    ];
    routeExec([], () => mainResults.shift() ?? exec());

    const result = await terminalShieldTool.execute({ command: "node index.js" }, CONTEXT);

    expect(executeAgentTerminalMock).toHaveBeenCalledTimes(2);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[1].command).toBe(
      "test -f package.json && npm install --no-audit --no-fund --silent lodash ; node index.js",
    );
    expect(result.attempts[1].fixApplied?.type).toBe("missing_dependency");
    expect(result.fixed).toBe(true);
  });

  it("module RELATIF introuvable (./utils) = bug de code : aucune réparation inventée", async () => {
    routeExec([
      {
        match: () => true,
        result: () =>
          exec({
            success: false,
            stderr: "Error: Cannot find module './utils/compat'",
            exitCode: 1,
          }),
      },
    ]);

    const result = await terminalShieldTool.execute({ command: "node index.js" }, CONTEXT);

    expect(executeAgentTerminalMock).toHaveBeenCalledTimes(1);
    expect(result.attempts).toHaveLength(1);
    expect(result.fixed).toBe(false);
    expect(result.attempts[0].stderrExcerpt).toContain("Cannot find module './utils/compat'");
  });

  it("permission refusée sur un script → chmod +x puis relance combinés", async () => {
    const mainResults = [
      exec({
        success: false,
        stderr: "bash: ./deploy.sh: Permission denied",
        exitCode: 126,
      }),
      exec({ stdout: "deployé" }),
    ];
    routeExec([
      // Pré-vol : le script existe (FOUND) — pas de correction de chemin.
      { match: isProbe, result: () => exec({ stdout: "FOUND ./deploy.sh\n" }) },
    ], () => mainResults.shift() ?? exec());

    const result = await terminalShieldTool.execute({ command: "./deploy.sh" }, CONTEXT);

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[1].command).toBe("chmod +x './deploy.sh' ; ./deploy.sh");
    expect(result.attempts[1].fixApplied?.type).toBe("permission");
    expect(result.fixed).toBe(true);
  });

  it("chaîne de correctifs bornée : deux dépendances successives réparées avec maxAutoFixes=2", async () => {
    const mainResults = [
      exec({ success: false, stderr: "Error: Cannot find module 'lodash'", exitCode: 1 }),
      exec({ success: false, stderr: "Error: Cannot find module 'axios'", exitCode: 1 }),
      exec({ stdout: "ok" }),
    ];
    routeExec([], () => mainResults.shift() ?? exec());

    const result = await terminalShieldTool.execute(
      { command: "node index.js", maxAutoFixes: 2 },
      CONTEXT,
    );

    expect(result.attempts).toHaveLength(3);
    expect(result.attempts[1].command).toBe(
      "test -f package.json && npm install --no-audit --no-fund --silent lodash ; node index.js",
    );
    expect(result.attempts[2].command).toBe(
      "test -f package.json && npm install --no-audit --no-fund --silent axios ; test -f package.json && npm install --no-audit --no-fund --silent lodash ; node index.js",
    );
    expect(result.fixed).toBe(true);
  });

  it("maxAutoFixes=0 : aucune relance après échec, fixed=false", async () => {
    routeExec([
      {
        match: () => true,
        result: () =>
          exec({
            success: false,
            stderr: "bash: line 1: python: command not found",
            exitCode: 127,
          }),
      },
    ]);

    const result = await terminalShieldTool.execute(
      { command: "python script.py", maxAutoFixes: 0 },
      CONTEXT,
    );

    expect(executeAgentTerminalMock).toHaveBeenCalledTimes(1);
    expect(result.attempts).toHaveLength(1);
    expect(result.fixed).toBe(false);
    expect(result.finalExitCode).toBe(127);
  });

  it("sonde de pré-vol en échec : non fatale — la commande d'origine est exécutée telle quelle", async () => {
    routeExec([
      {
        match: isProbe,
        result: () => exec({ success: false, stderr: "sonde rejetée", exitCode: 1 }),
      },
    ]);

    const result = await terminalShieldTool.execute({ command: "cat ./notes.txt" }, CONTEXT);

    expect(executeAgentTerminalMock).toHaveBeenCalledTimes(2);
    expect(executeAgentTerminalMock.mock.calls[1][0].command).toBe("cat ./notes.txt");
    expect(result.attempts).toHaveLength(1);
    expect(result.fixed).toBe(true);
  });

  it("sonde de pré-vol rejetée (exception du canal sécurisé) : non fatale également", async () => {
    routeExec([]);
    executeAgentTerminalMock.mockImplementation(async (params: { command: string }) => {
      if (isProbe(params.command)) throw new Error("Terminal command rejected by safety policy.");
      return exec({ stdout: "notes" });
    });

    const result = await terminalShieldTool.execute({ command: "cat ./notes.txt" }, CONTEXT);

    expect(executeAgentTerminalMock).toHaveBeenCalledTimes(2);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].command).toBe("cat ./notes.txt");
    expect(result.fixed).toBe(true);
  });

  it("transmet cwd et timeoutMs au canal sécurisé", async () => {
    routeExec([]);

    await terminalShieldTool.execute(
      { command: "npm run build", cwd: "/workspace/app", timeoutMs: 45_000 },
      CONTEXT,
    );

    expect(executeAgentTerminalMock.mock.calls[0][0]).toMatchObject({
      cwd: "/workspace/app",
      timeoutMs: 45_000,
    });
  });
});
