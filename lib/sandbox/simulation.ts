/**
 * Moteur d'exécution de code à deux modes :
 *
 *  1. « sandbox » — exécution Docker isolée (service sandbox/, réseau none,
 *     read-only) lorsque SANDBOX_URL + SANDBOX_SHARED_SECRET sont configurés.
 *
 *  2. « simulation » — repli intégré lorsque le service Docker n'est pas
 *     déployé (cas de la production serverless actuelle) :
 *       - node   : analyse statique structurée (littéraux et expressions
 *                  arithmétiques évalués sans eval, déclarations, flux,
 *                  constructions dangereuses rejetées) — JAMAIS
 *                  d'exécution réelle : `node:vm` n'est pas une frontière
 *                  de sécurité (les intrinsèques passés au contexte
 *                  exposent le realm hôte via Function.constructor) et
 *                  aucune réponse trompeuse n'est acceptable.
 *       - python : analyse statique structurée (imports, fonctions, flux,
 *                  prints évalués pour les littéraux, constructeurs
 *                  dangereux) — clairement étiquetée simulation, sans
 *                  prétendre à une exécution réelle.
 *       - shell  : dry-run commandé par commande (décision, description,
 *                  dangerosité), sans exécution.
 *
 * Le résultat porte TOUJOURS son mode : les agents (et l'UI) savent s'ils
 * regardent une exécution réelle ou une simulation — aucune réponse
 * trompeuse n'est acceptable.
 */

import { executeSandbox } from "./client";
import type { SandboxJob, SandboxResult } from "./types";

export interface ExecutionOutput extends SandboxResult {
  /** Mode réellement employé : exécution Docker ou simulation intégrée. */
  mode: "sandbox" | "simulation";

  /** Détail optionnel du moteur de simulation (trace, analyse). */
  simulation?: {
    engine: "static-node" | "static-python" | "static-shell";

    /** Trace structurée (étapes observées / analyses). */
    trace: string[];

    /** Avertissements de sécurité ou de qualité détectés. */
    warnings: string[];
  };
}

export function isSandboxConfigured(): boolean {
  return Boolean(process.env.SANDBOX_URL?.trim() && process.env.SANDBOX_SHARED_SECRET?.trim());
}

const MAX_SIMULATION_CODE_LENGTH = 500_000;
const MAX_SIMULATION_OUTPUT_CHARS = 200_000;
const MAX_TRACE_LINES = 200;

function truncate(text: string, max = MAX_SIMULATION_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[sortie tronquée : ${text.length - max} caractères supplémentaires]`;
}

/**
 * Chaîne d'exécution complète : sandbox Docker si disponible (et retombée
 * simulation en cas d'incident réseau du service), sinon simulation.
 */
export async function runSandboxOrSimulation(job: SandboxJob): Promise<ExecutionOutput> {
  if (isSandboxConfigured()) {
    try {
      const result = await executeSandbox(job);
      return { ...result, mode: "sandbox" };
    } catch (error) {
      // Le service sandbox est configuré mais indisponible : on dégrade en
      // simulation plutôt que d'échouer — le mode est annoncé honnêtement.
      const reason = error instanceof Error ? error.message : String(error);
      const simulation = await simulateSandboxJob(job);
      return {
        ...simulation,
        stderr: `${simulation.stderr}\n[sandbox indisponible, repli simulation — cause: ${reason.slice(0, 200)}]`.trim(),
      };
    }
  }
  return simulateSandboxJob(job);
}

/* ------------------------------------------------------------------ */
/* Simulation node — analyse statique structurée                       */
/* ------------------------------------------------------------------ */

/**
 * Évalue une expression arithmétique pure (chiffres et opérateurs
 * uniquement, shunting-yard sans eval) — échec silencieux si l'expression
 * sort de ce domaine strictement borné.
 */
function evaluerArithmetique(expression: string): number | null {
  if (!/^[-+*/%().\s\d]+$/.test(expression) || !/\d/.test(expression)) return null;
  const tokens = expression.match(/\d+(?:\.\d+)?|[-+*/%()]/g);
  if (!tokens) return null;
  const precedence: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2 };
  const output: string[] = [];
  const operators: string[] = [];
  for (const token of tokens) {
    if (/^\d/.test(token)) output.push(token);
    else if (token === "(") operators.push(token);
    else if (token === ")") {
      while (operators.length > 0 && operators[operators.length - 1] !== "(") output.push(operators.pop() as string);
      if (operators.pop() !== "(") return null;
    } else {
      while (operators.length > 0 && precedence[operators[operators.length - 1]] >= precedence[token]) output.push(operators.pop() as string);
      operators.push(token);
    }
  }
  while (operators.length > 0) {
    const op = operators.pop() as string;
    if (op === "(") return null;
    output.push(op);
  }
  const stack: number[] = [];
  for (const token of output) {
    if (/^\d/.test(token)) stack.push(Number(token));
    else {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) return null;
      stack.push(token === "+" ? a + b : token === "-" ? a - b : token === "*" ? a * b : token === "/" ? a / b : a % b);
    }
  }
  const result = stack.pop();
  return stack.length === 0 && result !== undefined && Number.isFinite(result) ? result : null;
}

interface NodeAnalysis {
  trace: string[];

  warnings: string[];

  outputs: string[];

  /** Construction interdite détectée : rejet dur (style politique shell). */
  rejected: boolean;

  /** Déséquilibre de délimiteurs : erreur de syntaxe probable. */
  syntaxSuspicion: boolean;
}

/** Constructions explicitement interdites en simulation (rejet dur) —
 * toute évasion de realm passe par l'une de ces portes. */
const NODE_REJECT: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\brequire\s*\(/, label: "require() (accès modules host)" },
  { pattern: /\bprocess\b/, label: "objet process (ressources host)" },
  { pattern: /\beval\s*\(/, label: "eval() (code dynamique)" },
  { pattern: /\bnew\s+Function\b/, label: "constructeur Function (code dynamique)" },
  { pattern: /\bglobalThis\b|\bglobal\b/, label: "globalThis/global (realm hôte)" },
  { pattern: /\bimport\s*\(/, label: "import() dynamique (modules host)" },
  { pattern: /constructor\s*\.\s*constructor|\[\s*["']constructor["']\s*\]|__proto__/, label: "manipulation de prototypes (tentative d'évasion)" },
];

function analyseNode(code: string): NodeAnalysis {
  const trace: string[] = [];
  const warnings: string[] = [];
  const outputs: string[] = [];
  const lines = code.split("\n");

  const constants = new Map<string, number>();
  const functions: string[] = [];
  let loops = 0;
  let conditionals = 0;
  let classes = 0;
  let rejected = false;

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;

    // Découpe en instructions au niveau des « ; » (hors guillemets) pour
    // analyser chaque segment indépendamment (numéro de ligne conservé).
    const statements: string[] = [];
    let quote: string | null = null;
    let currentStatement = "";
    for (const char of line) {
      if (quote) {
        currentStatement += char;
        if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        currentStatement += char;
      } else if (char === ";") {
        statements.push(currentStatement.trim());
        currentStatement = "";
      } else currentStatement += char;
    }
    if (currentStatement.trim()) statements.push(currentStatement.trim());

    for (const statement of statements) {
      for (const danger of NODE_REJECT) {
        if (danger.pattern.test(statement)) {
          warnings.push(`Ligne ${index + 1} : ${danger.label} — rejeté par la politique de sécurité Gen3ia.`);
          rejected = true;
        }
      }

      // const/let name = <arithmétique pure> — suivi de constantes.
      const constMatch = statement.match(/^(?:const|let|var)\s+([\w$]+)\s*=\s*([^;]+)$/);
      if (constMatch) {
        const value = evaluerArithmetique(constMatch[2]);
        if (value !== null) constants.set(constMatch[1], value);
        continue;
      }

      const functionMatch = statement.match(/^(?:async\s+)?function\s+[\w$]+\s*\(([^)]*)\)/);
      if (functionMatch) {
        functions.push(functionMatch[0].replace(/^(?:async\s+)?/, "").slice(0, 120));
        continue;
      }
      if (/^class\s+[\w$]+/.test(statement)) classes += 1;

      if (/^for\s*\(|^while\s*\(|^do\s*\{/.test(statement)) loops += 1;
      if (/^if\s*\(|^else\s+if\s*\(|^else\s*\{|^switch\s*\(/.test(statement)) conditionals += 1;

      // console.log("littéral") / console.log('littéral', expr) — évaluation
      // du cas simple : littéraux, constantes connues, arithmétique pure.
      const logMatch = statement.match(/^(?:console\.)?(?:log|info|warn|error|table|dir)\s*\((.+)\)$/);
      if (logMatch) {
        const parts = splitTopLevelArgs(logMatch[1]);
        const rendered = parts.map((part) => {
          const trimmed = part.trim();
          const stringMatch = trimmed.match(/^(?:'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)")$/);
          if (stringMatch) return (stringMatch[1] ?? stringMatch[2] ?? "").replace(/\\n/g, "\n");
          const constant = constants.get(trimmed);
          if (constant !== undefined) return String(constant);
          const arithmetic = evaluerArithmetique(trimmed);
          if (arithmetic !== null) return String(arithmetic);
          return "…";
        });
        outputs.push(`[ligne ${index + 1}] ${rendered.join(" ")}`);
        continue;
      }

      if (/\bwhile\s*\(\s*true\s*\)/.test(statement)) warnings.push(`Ligne ${index + 1} : boucle while(true) — sans exécution, mais signalée (risque en environnement réel).`);
    }
  }

  trace.push(`${lines.length} ligne(s) analysées`);
  if (functions.length > 0) trace.push(`Fonctions définies (${functions.length}) : ${functions.slice(0, 12).join(" · ")}`);
  if (classes > 0) trace.push(`${classes} classe(s) définie(s)`);
  trace.push(`Flux de contrôle : ${loops} boucle(s), ${conditionals} branchement(s) conditionnel(s)`);
  if (constants.size > 0) trace.push(`Constantes évaluées : ${[...constants.entries()].slice(0, 12).map(([name, value]) => `${name}=${value}`).join(", ")}`);
  if (outputs.length > 0) trace.push(`${outputs.length} sortie(s) console littérale(s) détectée(s)`);
  for (const output of outputs.slice(0, 50)) trace.push(output);
  trace.push("Exécution réelle disponible uniquement avec le sandbox isolé (SANDBOX_URL) — ici : analyse statique sans exécution.");

  // Équilibre grossier des délimiteurs (erreur de syntaxe évidente).
  let syntaxSuspicion = false;
  const pairs: Array<[string, string]> = [["(", ")"], ["[", "]"], ["{", "}"]];
  for (const [open, close] of pairs) {
    const diff = (code.match(new RegExp(`\\${open}`, "g"))?.length ?? 0) - (code.match(new RegExp(`\\${close}`, "g"))?.length ?? 0);
    if (diff !== 0) {
      warnings.push(`Délimiteurs déséquilibrés ${open}${close} (${diff > 0 ? `${diff} ouvert(s) non fermé(s)` : `${-diff} fermé(s) en excès`}) — erreur de syntaxe probable.`);
      syntaxSuspicion = true;
    }
  }

  return { trace, warnings, outputs, rejected, syntaxSuspicion };
}

/** Découpe les arguments d'appel au niveau supérieur (virgules hors
 * guillemets et hors parenthèses), borné à 8 arguments. */
function splitTopLevelArgs(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const char of input) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (char === "(" || char === "[") {
      depth += 1;
      current += char;
    } else if (char === ")" || char === "]") {
      depth -= 1;
      current += char;
    } else if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      if (parts.length >= 8) return parts;
    } else current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/* ------------------------------------------------------------------ */
/* Simulation python — analyse statique structurée                     */
/* ------------------------------------------------------------------ */

interface PythonAnalysis {
  trace: string[];

  warnings: string[];

  outputs: string[];
}

function analysePython(code: string): PythonAnalysis {
  const trace: string[] = [];
  const warnings: string[] = [];
  const outputs: string[] = [];
  const lines = code.split("\n");

  const imports = new Set<string>();
  const functions: string[] = [];
  let loops = 0;
  let conditionals = 0;
  let classes = 0;

  const DANGEROUS = [
    { pattern: /\bos\.system\s*\(/, label: "os.system (exécution shell)" },
    { pattern: /\bsubprocess\b/, label: "subprocess (exécution de processus)" },
    { pattern: /\beval\s*\(|\bexec\s*\(/, label: "eval/exec (code dynamique)" },
    { pattern: /\bopen\s*\([^)]*['"][wax]\+?['"]/, label: "ouverture de fichier en écriture" },
    { pattern: /\bsocket\b/, label: "socket réseau" },
    { pattern: /\bshutil\.rmtree\s*\(/, label: "shutil.rmtree (suppression récursive)" },
  ];

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const importMatch = line.match(/^(?:import\s+([\w.,\s]+)|from\s+([\w.]+)\s+import\s+([\w.,\s*]+))/);
    if (importMatch) {
      const names = (importMatch[1] ?? importMatch[3] ?? "").split(",").map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      for (const name of names) imports.add(importMatch[2] ? `${importMatch[2]}.${name}` : name);
      continue;
    }

    const defMatch = line.match(/^def\s+([\w_]+)\s*\(([^)]*)\)/);
    if (defMatch) {
      functions.push(`${defMatch[1]}(${defMatch[2].slice(0, 120)})`);
      continue;
    }
    if (/^class\s+[\w_]+/.test(line)) classes += 1;

    if (/^for\s+.+:\s*$/.test(line) || /^while\s+.+:\s*$/.test(line)) loops += 1;
    if (/^if\s+.+:\s*$/.test(line) || /^elif\s+.+:\s*$/.test(line) || /^else\s*:\s*$/.test(line)) conditionals += 1;

    // print("littéral") / print('littéral') / print(f"...") — évaluation
    // du cas simple : le littéral seul, sans interpolation exécutée.
    const printMatch = line.match(/^print\s*\(\s*(["'])(.*?)\1\s*\)\s*$/);
    if (printMatch) outputs.push(`[ligne ${index + 1}] ${printMatch[2].replace(/\{([^}]*)\}/g, "«$1»")}`);

    for (const danger of DANGEROUS) {
      if (danger.pattern.test(line)) warnings.push(`Ligne ${index + 1} : ${danger.label} — bloqué ou à surveiller en environnement réel.`);
    }
  }

  trace.push(`${lines.length} ligne(s) analysées`);
  if (imports.size > 0) trace.push(`Modules importés : ${[...imports].slice(0, 20).join(", ")}`);
  if (functions.length > 0) trace.push(`Fonctions définies (${functions.length}) : ${functions.slice(0, 12).join(" · ")}`);
  if (classes > 0) trace.push(`${classes} classe(s) définie(s)`);
  trace.push(`Flux de contrôle : ${loops} boucle(s), ${conditionals} branchement(s) conditionnel(s)`);
  if (outputs.length > 0) trace.push(`${outputs.length} sortie(s) print littérale(s) détectée(s)`);
  for (const output of outputs.slice(0, 50)) trace.push(output);

  // Équilibre grossier des délimiteurs (erreur de syntaxe évidente).
  const pairs: Array<[string, string]> = [["(", ")"], ["[", "]"], ["{", "}"]];
  for (const [open, close] of pairs) {
    const diff = (code.match(new RegExp(`\\${open}`, "g"))?.length ?? 0) - (code.match(new RegExp(`\\${close}`, "g"))?.length ?? 0);
    if (diff !== 0) warnings.push(`Délimiteurs déséquilibrés ${open}${close} (${diff > 0 ? `${diff} ouvert(s) non fermé(s)` : `${-diff} fermé(s) en excès`}) — erreur de syntaxe probable.`);
  }

  return { trace, warnings, outputs };
}

/* ------------------------------------------------------------------ */
/* Simulation shell — dry-run commandé par commande                    */
/* ------------------------------------------------------------------ */

const SHELL_DENY = [
  { pattern: /(^|\s)(sudo|su)\b/i, label: "élévation de privilèges" },
  { pattern: /rm\s+(?:-[^\s]*\s+)*-?rf\s+\//i, label: "rm -rf / (destruction racine)" },
  { pattern: /mkfs(?:\.[a-z0-9]+)?\b/i, label: "formatage de système de fichiers" },
  { pattern: /(?:curl|wget)\s+[^\n]*\|\s*(?:ba)?sh/i, label: "téléchargement + exécution immédiate" },
  { pattern: /\b(?:shutdown|reboot|poweroff|halt)\b/i, label: "extinction du système" },
  { pattern: /\b(?:nc|netcat|socat)\b/i, label: "outil réseau brut" },
  { pattern: /\/proc\/|\/sys\/|\/dev\/mem|\/dev\/kmem/i, label: "accès aux périphériques système" },
];

function describeShellCommand(command: string): string {
  const token = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const descriptions: Record<string, string> = {
    ls: "liste les fichiers du répertoire",
    cat: "affiche le contenu d'un fichier",
    head: "affiche le début d'un fichier",
    tail: "affiche la fin d'un fichier",
    grep: "recherche un motif dans des fichiers/entrées",
    find: "recherche des fichiers par critères",
    echo: "affiche un texte",
    pwd: "affiche le répertoire courant",
    mkdir: "crée un répertoire",
    touch: "crée un fichier vide",
    cp: "copie des fichiers",
    mv: "déplace/renomme des fichiers",
    rm: "supprime des fichiers",
    node: "exécute un script Node.js",
    python: "exécute un script Python",
    python3: "exécute un script Python",
    pip: "gère les paquets Python",
    npm: "gère les paquets Node.js",
    git: "opérations de gestion de version",
    curl: "requête HTTP sortante",
    wget: "téléchargement HTTP",
    wc: "compte lignes/mots/caractères",
    sed: "édition de flux de texte",
    awk: "traitement de texte orienté colonnes",
    sort: "trie des lignes",
    uniq: "déduplique des lignes adjacentes",
    chmod: "modifie les permissions de fichiers",
    which: "localise une commande",
    env: "affiche les variables d'environnement",
    df: "affiche l'usage disque",
    du: "affiche la taille des répertoires",
  };
  return descriptions[token] ? `${token} — ${descriptions[token]}` : `${token || "(vide)"} — commande (effet non simulé)`;
}

function analyseShell(command: string): { trace: string[]; warnings: string[] } {
  const trace: string[] = [];
  const warnings: string[] = [];

  // Analyse de sécurité sur la commande ENTIÈRE d'abord : les patterns de
  // rejet croisent plusieurs segments (ex. « curl … | sh ») qui seraient
  // séparés par le découpage pipeline ci-dessous.
  for (const deny of SHELL_DENY) {
    if (deny.pattern.test(command)) {
      warnings.push(`Commande rejetée par la politique de sécurité Gen3ia : ${deny.label}.`);
    }
  }

  const segments = command
    .split(/\n|&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .slice(0, 100);

  trace.push(`${segments.length} commande(s) dans le pipeline`);
  segments.forEach((segment, index) => {
    trace.push(`[${index + 1}] ${describeShellCommand(segment)}`);
    for (const deny of SHELL_DENY) {
      if (deny.pattern.test(segment)) {
        warnings.push(`Commande ${index + 1} : ${deny.label} — rejetée par la politique de sécurité Gen3ia.`);
      }
    }
  });

  return { trace, warnings };
}

/* ------------------------------------------------------------------ */
/* Point d'entrée de la simulation                                     */
/* ------------------------------------------------------------------ */

export async function simulateSandboxJob(job: SandboxJob): Promise<ExecutionOutput> {
  const startedAt = Date.now();

  if (job.code.length > MAX_SIMULATION_CODE_LENGTH) {
    return { success: false, stdout: "", stderr: "Code trop volumineux pour la simulation.", exitCode: 1, durationMs: 0, mode: "simulation" };
  }

  if (job.runtime === "node") {
    const analysis = analyseNode(job.code);
    return {
      success: !analysis.rejected && !analysis.syntaxSuspicion,
      stdout: truncate(analysis.outputs.join("\n")),
      stderr: analysis.rejected
        ? "Simulation : au moins une construction interdite viole la politique de sécurité (voir le journal)."
        : analysis.syntaxSuspicion
          ? "Simulation : erreur de syntaxe probable détectée."
          : "",
      exitCode: analysis.rejected ? 126 : analysis.syntaxSuspicion ? 1 : 0,
      durationMs: Date.now() - startedAt,
      mode: "simulation",
      simulation: {
        engine: "static-node",
        trace: analysis.trace,
        warnings: analysis.warnings,
      },
    };
  }

  if (job.runtime === "python") {
    const analysis = analysePython(job.code);
    const syntaxSuspicion = analysis.warnings.some((warning) => warning.includes("syntaxe probable"));
    return {
      success: !syntaxSuspicion,
      stdout: truncate(analysis.outputs.join("\n")),
      stderr: syntaxSuspicion ? "Simulation : erreur de syntaxe probable détectée." : "",
      exitCode: syntaxSuspicion ? 1 : 0,
      durationMs: Date.now() - startedAt,
      mode: "simulation",
      simulation: {
        engine: "static-python",
        trace: analysis.trace,
        warnings: analysis.warnings,
      },
    };
  }

  // shell
  const shell = analyseShell(job.code);
  const rejected = shell.warnings.length > 0;
  return {
    success: !rejected,
    stdout: "",
    stderr: rejected ? "Simulation : au moins une commande viole la politique de sécurité (voir le journal)." : "",
    exitCode: rejected ? 126 : 0,
    durationMs: Date.now() - startedAt,
    mode: "simulation",
    simulation: {
      engine: "static-shell",
      trace: shell.trace,
      warnings: shell.warnings,
    },
  };
}

/** Budget de trace borné pour la persistance (idempotence/observabilité). */
export function clampTrace(trace: string[]): string[] {
  return trace.slice(0, MAX_TRACE_LINES).map((line) => line.slice(0, 2_000));
}
