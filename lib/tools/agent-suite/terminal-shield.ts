import { z } from "zod";

import { executeAgentTerminal } from "@/lib/agents/runtime/agent-terminal";
import type { ToolDefinition } from "@/lib/tools/types";

/**
 * OUTIL AGENT « terminal.shield » — Terminal Daemon Shield & Sandbox (Task 140).
 *
 * Orchestrateur qui SURVEILLE l'exécution d'une commande, INTERCEPTE les
 * erreurs de build (chemin/répertoire erroné, commande introuvable,
 * dépendance manquante, permission) et AUTO-RÉPARE avant l'échec final.
 *
 * FAIT ARCHITECTURAL FONDAMENTAL : executeAgentTerminal s'exécute dans un
 * espace de travail ÉPHÉMÈRE (/tmp par invocation) — AUCUN état ne persiste
 * entre deux appels. Les auto-réparations produisent donc TOUJOURS des
 * commandes COMBINÉES complètes en UNE SEULE invocation (ex. installation
 * de la dépendance PUIS relance de la commande, enchaînées par « ; ») —
 * jamais un enchaînement « install » puis « run » sur deux invocations.
 *
 * SÉCURITÉ — MÊME CANAL SÉCURISÉ QUE LE TERMINAL AGENT : chaque exécution
 * (sonde de pré-vol, localisation find, tentative principale) passe par
 * executeAgentTerminal, qui applique la DENY-LIST PARTAGÉE
 * (lib/sandbox/policy.ts, réévaluée avant tout spawn) et les bornes
 * temps/mémoire/sortie du runtime. Aucune exécution ne contourne ce canal :
 * les commandes de réparation elles-mêmes y sont soumises (d'où le filtrage
 * `/proc*`/`/sys*` sans slash final dans la commande find, rejeter la
 * sonde ferait échouer la défense plutôt que la renforcer). Les appels
 * sont tous scopés au userId de l'exécution agent en cours.
 *
 * Pipeline :
 *  1. PRÉ-VOL : extraction des tokens « chemin » de la commande, sonde
 *     d'existence EN UNE commande combinée (`if [ -e … ]; printf FOUND/MISSING`),
 *     puis localisation bornée (`find / -maxdepth 5 … | head -3`) pour les
 *     chemins manquants — correction uniquement si UN SEUL candidat du même
 *     nom de base est trouvé (sinon : ambigu, on n'invente rien).
 *  2. EXÉCUTION de la commande (éventuellement corrigée par le pré-vol).
 *  3. AUTO-RÉPARATION POST-ÉCHEC (bornée par maxAutoFixes) : alias de
 *     commande (python→python3…), dépendance npm manquante (install+run
 *     combinés), script non exécutable (chmod+run combinés). Les chemins
 *     introuvables après pré-vol et les modules relatifs (bugs de code)
 *     sont signalés HONNÊTEMENT, jamais « réparés » à l'aveugle.
 */

const inputSchema = z.object({
  command: z.string().min(1).max(10_000),
  cwd: z.string().max(500).optional(),
  maxAutoFixes: z.number().int().min(0).max(3).default(1),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
});

/** Alias déterministes pour les commandes absentes du PATH. */
const COMMAND_ALTERNATES: Record<string, string> = {
  python: "python3",
  pip: "pip3",
  nodejs: "node",
  tsc: "npx tsc",
  http: "curl",
  https: "curl",
  wget: "curl -L -O",
  "ts-node": "npx ts-node",
  eslint: "npx eslint",
  jest: "npx jest",
  prettier: "npx prettier",
};

export type TerminalShieldFixType =
  | "path_correction"
  | "command_alias"
  | "missing_dependency"
  | "permission";

export interface TerminalShieldFix {
  type: TerminalShieldFixType;
  description: string;
}

export interface TerminalShieldAttempt {
  command: string;
  exitCode: number | null;
  mode: string;
  success: boolean;
  stderrExcerpt: string;
  fixApplied?: TerminalShieldFix;
}

export interface TerminalShieldResult {
  attempts: TerminalShieldAttempt[];
  finalExitCode: number | null;
  fixed: boolean;
  mode: string;
}

/** Échappement shell en simple quotes : ' → '\'' (canonique POSIX). */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

/**
 * Extrait les tokens « chemin » d'une commande : mots contenant un « / » et
 * chaînes entre quotes. Ignore http(s)://, /tmp, les options (-x, --k=v) et
 * les tokens > 500 caractères. Maximum 10 tokens sondés.
 */
export function extractPathTokens(command: string): string[] {
  const candidates = new Set<string>();
  for (const quoted of command.match(/'[^']*'|"[^"]*"/g) ?? []) {
    candidates.add(quoted.slice(1, -1));
  }
  for (const word of command.match(/\S+/g) ?? []) {
    candidates.add(word);
  }
  const paths: string[] = [];
  for (const raw of candidates) {
    let token = raw.trim();
    // Mots entre quotes (déjà déquotés via le premier jeu) ou re-quotés.
    if (/^['"].*['"]$/.test(token) && token.length >= 2) token = token.slice(1, -1);
    // Ponctuation de collage shell : `cmd path,` `cmd path;` `(path)`.
    token = token.replace(/[,;)]+$/, "");
    // Préfixe de redirection : `>path` `2>path`.
    token = token.replace(/^[<>]+/, "");
    if (!token.includes("/")) continue;
    if (token.startsWith("http://") || token.startsWith("https://")) continue;
    if (token === "/tmp" || token.startsWith("/tmp/")) continue;
    if (token.startsWith("-") || token.includes("=")) continue;
    if (token.length > 500) continue;
    if (!paths.includes(token)) paths.push(token);
    if (paths.length >= 10) break;
  }
  return paths;
}

/** Nom de paquet nu (installable) : jamais un chemin relatif/absolu de code. */
function isBarePackageName(name: string): boolean {
  if (name.startsWith("./") || name.startsWith("../") || name.startsWith("/")) return false;
  return /^[a-z0-9@/._-]{1,100}$/i.test(name);
}

interface DerivedFix {
  type: TerminalShieldFixType;
  description: string;
  command: string;
}

/** Déduit une réparation déterministe de l'échec (ou null : rien à tenter). */
function derivePostFailureFix(stderr: string, command: string): DerivedFix | null {
  // 1. Commande introuvable — alias déterministe (première occurrence seule).
  const notFound =
    /command not found: (\S+)/.exec(stderr) ??
    /^\s*[^\n:]+:\s*(?:line\s+\d+:\s*|\d+:\s*)?([^\s:]+):\s*(?:command\s+)?not found\b/m.exec(
      stderr,
    );
  if (notFound) {
    const missing = notFound[1];
    const alternate = COMMAND_ALTERNATES[missing];
    if (!alternate) return null;
    const corrected = command.replace(new RegExp(`\\b${escapeRegExp(missing)}\\b`), alternate);
    if (corrected === command) return null;
    return {
      type: "command_alias",
      description: `Commande « ${missing} » introuvable dans le PATH — relancée avec « ${alternate} ».`,
      command: corrected,
    };
  }

  // 2. Dépendance manquante — install + relance EN UNE SEULE commande
  //    (l'espace de travail est éphémère, un « npm install » isolé serait perdu).
  const moduleMatch =
    /Cannot find module '([^']+)'/.exec(stderr) ??
    /Can't resolve '([^']+)'/.exec(stderr) ??
    /Can't find module '([^']+)'/.exec(stderr);
  if (moduleMatch) {
    const moduleName = moduleMatch[1];
    if (!isBarePackageName(moduleName)) return null; // chemin relatif = bug de code.
    return {
      type: "missing_dependency",
      description: `Dépendance « ${moduleName} » manquante — installation npm puis relance combinées en une seule invocation.`,
      command: `test -f package.json && npm install --no-audit --no-fund --silent ${moduleName} ; ${command}`,
    };
  }

  // 3. Script non exécutable — chmod +x puis relance combinées.
  const permission = /([^\s:]+):\s*[Pp]ermission denied/.exec(stderr);
  if (permission) {
    const script = permission[1];
    return {
      type: "permission",
      description: `Script « ${script} » non exécutable — chmod +x puis relance combinées en une seule invocation.`,
      command: `chmod +x ${shellSingleQuote(script)} ; ${command}`,
    };
  }

  return null;
}

export const terminalShieldTool: ToolDefinition<
  z.infer<typeof inputSchema>,
  TerminalShieldResult
> = {
  id: "terminal.shield",
  name: "Terminal Daemon Shield & Sandbox",
  description:
    "Run a shell command in the Gen3ia agent terminal with a watchdog: pre-flight path existence probing, bounded locate-and-correction of wrong paths, and bounded post-failure auto-repair (missing command alias, missing npm dependency, non-executable script) — every execution goes through the same hardened secure channel (deny-list, time/memory/output limits, ephemeral /tmp workspace). Returns the full attempt log and the honest final status.",
  category: "code",
  risk: "medium",
  inputSchema,
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    const executionId = context.executionId ?? "terminal-shield";
    const attempts: TerminalShieldAttempt[] = [];

    const runSecure = async (command: string, timeoutMs?: number) =>
      executeAgentTerminal({
        userId: context.userId,
        executionId,
        command,
        cwd: parsed.cwd,
        timeoutMs,
      });

    // ─── 1. PRÉ-VOL : sonde d'existence des chemins (non fatale) ───
    let currentCommand = parsed.command;
    let preFlightFix: TerminalShieldFix | undefined;

    const pathTokens = extractPathTokens(parsed.command);
    const missingPaths: string[] = [];
    if (pathTokens.length > 0) {
      try {
        const probeParts = pathTokens.map((path) => {
          const quoted = shellSingleQuote(path);
          return `if [ -e ${quoted} ]; then printf 'FOUND %s\\n' ${quoted}; else printf 'MISSING %s\\n' ${quoted}; fi`;
        });
        const probe = await runSecure(probeParts.join("\n"));
        if (probe.success) {
          for (const line of probe.stdout.split("\n")) {
            const missing = /^MISSING (.+)$/.exec(line.trim());
            if (missing && !missingPaths.includes(missing[1])) missingPaths.push(missing[1]);
          }
        }
        // Probe en échec → pré-vol sauté (non fatal), exécution telle quelle.
      } catch {
        // Sonde rejetée/échouée → pré-vol sauté (non fatal).
      }
    }

    // ─── Localisation bornée des chemins manquants (max 3 sondés) ───
    for (const missingPath of missingPaths.slice(0, 3)) {
      try {
        const base = shellSingleQuote(basename(missingPath));
        // NB : filtres /proc* et /sys* SANS slash final — la deny-list partagée
        // rejette tout littéral « /proc/ » ou « /sys/ » dans la commande.
        const locate = await runSecure(
          `find / -maxdepth 5 -name ${base} -not -path '*/node_modules/*' -not -path '/proc*' -not -path '/sys*' 2>/dev/null | head -3`,
          15_000,
        );
        if (!locate.success) continue;
        const candidates = [...new Set(locate.stdout.split("\n").map((l) => l.trim()).filter(Boolean))];
        if (candidates.length !== 1) continue; // ambigu ou introuvable → honnête.
        const candidate = candidates[0];
        if (basename(candidate) !== basename(missingPath)) continue;
        const quotedCandidate = shellSingleQuote(candidate);
        const corrected = currentCommand.split(missingPath).join(quotedCandidate);
        if (corrected === currentCommand) continue;
        currentCommand = corrected;
        preFlightFix = {
          type: "path_correction",
          description: `Chemin « ${missingPath} » introuvable — remplacé par « ${candidate} » (localisé via find).`,
        };
        break; // une correction par invocation : rester minimal et lisible.
      } catch {
        continue; // localisation impossible → pas de correction.
      }
    }

    // ─── 2/3. EXÉCUTION + AUTO-RÉPARATION POST-ÉCHEC bornée ───
    let fixesUsed = 0;
    let pendingFix = preFlightFix;

    while (true) {
      const execution = await runSecure(currentCommand, parsed.timeoutMs);
      attempts.push({
        command: currentCommand,
        exitCode: execution.exitCode,
        mode: execution.mode,
        success: execution.success,
        stderrExcerpt: execution.stderr.slice(-500),
        fixApplied: pendingFix,
      });
      const failed = execution.success === false || (execution.exitCode ?? 0) !== 0;
      if (!failed) break;
      if (fixesUsed >= parsed.maxAutoFixes) break;
      if (!execution.stderr.trim()) break;
      const fix = derivePostFailureFix(execution.stderr, currentCommand);
      if (!fix) break; // échec « non réparable » : rapporté honnêtement.
      fixesUsed += 1;
      currentCommand = fix.command;
      pendingFix = { type: fix.type, description: fix.description };
    }

    const finalAttempt = attempts[attempts.length - 1];
    const finalFailed =
      finalAttempt.success === false || (finalAttempt.exitCode ?? 0) !== 0;
    return {
      attempts,
      finalExitCode: finalAttempt.exitCode,
      fixed: !finalFailed,
      mode: finalAttempt.mode,
    };
  },
};
