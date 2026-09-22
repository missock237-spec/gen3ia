/**
 * Moteur d'exécution de code à deux modes :
 *
 *  1. « sandbox » — exécution Docker isolée (service sandbox/, réseau none,
 *     read-only) lorsque SANDBOX_URL + SANDBOX_SHARED_SECRET sont configurés.
 *
 *  2. « simulation » — repli intégré lorsque le service Docker n'est pas
 *     déployé (cas de la production serverless actuelle) :
 *       - node   : VRAIE exécution JavaScript dans `node:vm` — contexte
 *                  gelé (aucun require/process/fs/net), quotas CPU par
 *                  timeout natif V8, sortie capturée et bornée.
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

import vm from "node:vm";

import { executeSandbox } from "./client";
import type { SandboxJob, SandboxResult } from "./types";

export interface ExecutionOutput extends SandboxResult {
  /** Mode réellement employé : exécution Docker ou simulation intégrée. */
  mode: "sandbox" | "simulation";

  /** Détail optionnel du moteur de simulation (trace, analyse). */
  simulation?: {
    engine: "node-vm" | "static-python" | "static-shell";

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
const MAX_VM_TIMEOUT_MS = 5_000;
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
/* Simulation node — vraie exécution VM restreinte                     */
/* ------------------------------------------------------------------ */

function buildNodeSimulation(code: string, timeoutMs: number): { stdout: string; stderr: string; exitCode: number; trace: string[]; warnings: string[] } {
  const stdoutLines: string[] = [];
  const warnings: string[] = [];
  const push = (...args: unknown[]) => {
    const text = args
      .map((line) => (typeof line === "string" ? line : (() => { try { return JSON.stringify(line); } catch { return String(line); } })()))
      .join(" ");
    if (stdoutLines.length < 5_000) stdoutLines.push(text);
    else if (stdoutLines.length === 5_000) stdoutLines.push("[... sortie console plafonnée ...]");
  };
  const console2 = {
    log: push,
    info: push,
    warn: push,
    error: push,
    debug: () => undefined,
    table: push,
    dir: push,
  };

  // Contexte minimal et gelé : aucune escape vers les ressources du host.
  const sandbox: Record<string, unknown> = {
    console: console2,
    Math,
    JSON,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Symbol,
    BigInt,
    Promise,
    RegExp,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    isNaN,
    isFinite,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    structuredClone,
    TextEncoder,
    TextDecoder,
    Intl,
    NaN,
    Infinity,
    undefined,
  };

  // Détection statique préalable des tentatives d'évasion (avertissement).
  if (/\brequire\s*\(/.test(code)) warnings.push("require() n'est pas disponible en simulation VM (module refusé).");
  if (/\bprocess\b/.test(code)) warnings.push("L'objet process n'est pas exposé en simulation VM.");
  if (/\bimport\s*\(|\bimport\s+/.test(code)) warnings.push("Les imports ES modules ne sont pas supportés en simulation VM (code CommonJS pur attendu).");
  if (/\bglobalThis\b|\bglobal\b/.test(code)) warnings.push("globalThis est restreint au contexte simulé.");
  if (/\bwhile\s*\(\s*true\s*\)/.test(code)) warnings.push("Boucle while(true) détectée : le timeout VM l'interrompra.");

  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const script = new vm.Script(code, { filename: "gen3ia-simulation.js" });
  const startedAt = Date.now();
  try {
    script.runInContext(context, { timeout: Math.min(timeoutMs, MAX_VM_TIMEOUT_MS), displayErrors: true, breakOnSigint: true });
    return {
      stdout: truncate(stdoutLines.join("\n")),
      stderr: "",
      exitCode: 0,
      trace: [`Exécution VM terminée en ${Date.now() - startedAt} ms`, `${stdoutLines.length} ligne(s) de sortie console`],
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return {
      stdout: truncate(stdoutLines.join("\n")),
      stderr: truncate(message),
      exitCode: 1,
      trace: [`Exécution VM interrompue après ${Date.now() - startedAt} ms`],
      warnings,
    };
  }
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

  const effectiveTimeout = Math.min(job.limits.timeoutMs, MAX_VM_TIMEOUT_MS);

  if (job.runtime === "node") {
    const result = buildNodeSimulation(job.code, effectiveTimeout);
    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      mode: "simulation",
      simulation: {
        engine: "node-vm",
        trace: result.trace,
        warnings: result.warnings,
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
