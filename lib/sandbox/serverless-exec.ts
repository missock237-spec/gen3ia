/**
 * EXÉCUTION RÉELLE « SERVERLESS » (Task 122 — terminal intégré fonctionnel).
 *
 * Un Vercel Node function tourne dans une microVM éphémère et isolée (aucun
 * voisin sur l'hôte) : l'exécution réelle en-processus y est acceptable à
 * condition d'y appliquer les garde-fous suivants, TOUS implémentés ici :
 *
 *  1. ENVIRONNEMENT DE SUBPROCESS NETTOYÉ : AUCUNE variable d'environnement
 *     héritée — un env minimal est construit de toutes pièces (PATH standard,
 *     HOME=/tmp, LANG, TMPDIR=/tmp). Les secrets du process parent (clés API,
 *     jetons Firebase…) sont INVISIBLES du code exécuté.
 *  2. CWD DANS /tmp : le répertoire de travail est un workspace /tmp fraîchement
 *     créé (jamais le répertoire du bundle). Le workspace est DÉTERMINISTE par
 *     utilisateur (mécanisme partagé avec lib/execution/workspace) : réutilisé
 *     tant que l'instance est « chaude », recréé vide après un démarrage à froid
 *     — l'éphémérité serverless est assumée et documentée honnêtement.
 *  3. ULIMIT MÉMOIRE quand possible : `bash --noprofile -lc 'ulimit -v …; cmd'`.
 *     Limitation EMPIRIQUE : V8 (node 22+) réserve ~2–4 Go d'adressage
 *     virtuel au démarrage — un ulimit -v bas tue TOUTE commande invoquant
 *     node (`node script.js`) avant son premier log. Le plafond virtuel du
 *     shell est donc max(mémoire demandée, 4 Go) : les mappings fous restent
 *     bornés et la microVM elle-même (kill plateforme à son plafond mémoire)
 *     borne l'RSS. Le tas V8 du runtime node est plafonné par
 *     --max-old-space-size ; le runtime python garde l'ulimit -v STRICT.
 *  4. TIMEOUT DUR : spawn en groupe de processus distinct (detached) et kill
 *     du TREE entier (kill -pgid SIGKILL) à l'échéance.
 *  5. SORTIE PLAFONNÉE : au-delà de maxOutputBytes, le processus est tué et la
 *     sortie tronquée (marqueur honnête dans le résultat).
 *  6. DENY-LIST DURCIE : réévaluée ici avant TOUT spawn shell (défense en
 *     profondeur — elle est déjà appliquée par les appelants via
 *     lib/sandbox/policy.ts).
 *
 * Le résultat porte TOUJOURS `mode: "serverless"` : le client sait qu'il
 * s'agit d'une exécution réelle locale (microVM), distincte du sandbox Docker
 * et de la simulation.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createExecutionWorkspace } from "@/lib/execution/workspace";
import { TERMINAL_MAX_COMMAND_LENGTH, findTerminalDenial } from "./policy";
import type { SandboxJob, SandboxResult } from "./types";

export interface ServerlessExecutionOutput extends SandboxResult {
  mode: "serverless";
  /** Le processus a été tué par le timeout dur. */
  timedOut: boolean;
  /** La sortie a dépassé le plafond : processus tué, sortie tronquée. */
  outputTruncated: boolean;
}

/* ------------------------------------------------------------------ */
/* Environnement minimal (AUCUN héritage de process.env)              */
/* ------------------------------------------------------------------ */

/**
 * Env MINIMAL du subprocess : PATH standard, HOME=/tmp, LANG, TMPDIR=/tmp.
 * Construit intentionnellement à la main — JAMAIS un spread de process.env
 * (une seule variable oubliée fuiterait un secret vers le code exécuté).
 * Le cast est délibéré : l'augmentation globale Next marque NODE_ENV requis
 * dans ProcessEnv, mais le subprocess ne doit JUSTEMENT PAS l'hériter.
 */
const MINIMAL_ENV: NodeJS.ProcessEnv = Object.freeze({
  PATH: "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin",
  HOME: "/tmp",
  LANG: "C.UTF-8",
  TMPDIR: "/tmp",
}) as unknown as NodeJS.ProcessEnv;

/** Plancher d'espace d'adressage virtuel pour Node (V8 réserve ~4 Go). */
const NODE_VIRTUAL_ADDRESS_SPACE_KB = 4 * 1024 * 1024;

/** Bornes défensives (les appelants clampons déjà — double sécurité). */
function clampLimits(job: SandboxJob): Required<Pick<SandboxJob["limits"], "timeoutMs" | "memoryMb" | "maxOutputBytes">> {
  return {
    timeoutMs: Math.min(Math.max(Math.floor(job.limits.timeoutMs) || 30_000, 100), 120_000),
    memoryMb: Math.min(Math.max(Math.floor(job.limits.memoryMb) || 512, 64), 2_048),
    maxOutputBytes: Math.min(Math.max(Math.floor(job.limits.maxOutputBytes) || 1_000_000, 1_024), 10_000_000),
  };
}

/* ------------------------------------------------------------------ */
/* Détection des runtimes locaux (cache par process)                  */
/* ------------------------------------------------------------------ */

const runtimeProbeCache = new Map<string, boolean>();

function probeBinary(binary: string, args: string[]): boolean {
  const key = `${binary} ${args.join(" ")}`;
  const cached = runtimeProbeCache.get(key);
  if (cached !== undefined) return cached;
  let available = false;
  try {
    const probe = spawnSync(binary, args, { env: MINIMAL_ENV, timeout: 5_000, stdio: "ignore" });
    available = probe.status === 0;
  } catch {
    available = false;
  }
  runtimeProbeCache.set(key, available);
  return available;
}

/** Reset du cache de détection (tests). */
export function resetServerlessRuntimeProbes(): void {
  runtimeProbeCache.clear();
}

/**
 * L'exécution réelle locale est-elle POSSIBLE pour ce runtime ?
 *  - node   : toujours (binaire = process.execPath) ;
 *  - shell  : si bash est présent ;
 *  - python : si python3 est présent dans le PATH minimal.
 * Si non, la chaîne de décision (lib/sandbox/simulation.ts) retombe sur une
 * SIMULATION ANNONCÉE — jamais de prétention d'exécution réelle.
 */
export function isServerlessExecutionPossible(runtime: SandboxJob["runtime"]): boolean {
  if (runtime === "node") return true;
  if (runtime === "shell") return probeBinary("bash", ["--noprofile", "-lc", "exit 0"]);
  return probeBinary("python3", ["--version"]);
}

/* ------------------------------------------------------------------ */
/* Workspace /tmp par utilisateur (mécanisme existant réutilisé)       */
/* ------------------------------------------------------------------ */

/**
 * Workspace /tmp DÉTERMINISTE par utilisateur : `createExecutionWorkspace`
 * (mécanisme partagé avec le terminal utilisateur et les exécutions) dérive
 * un hash stable de la clé → le même répertoire est RÉUTILISÉ tant que
 * l'instance serverless est chaude, recréé vide après un démarrage à froid.
 * AUCUN état n'est garanti entre deux commandes froides — l'appelant et
 * l'UI l'annoncent honnêtement.
 */
export async function ensureServerlessWorkspace(userId: string): Promise<{ id: string; root: string }> {
  return createExecutionWorkspace(`agent-terminal:${userId}`);
}

/**
 * Résout le cwd demandé dans le workspace : le préfixe /workspace (convention
 * du sandbox Docker) est projeté sur la racine locale ; toute évasion (..,
 * chemin absolu extérieur) est rabattue sur la racine — le cwd reste TOUJOURS
 * dans /tmp.
 */
function resolveWorkspaceCwd(root: string, requested: unknown): string {
  if (typeof requested !== "string" || !requested.trim()) return root;
  let sub = requested;
  if (sub.startsWith("/workspace")) sub = sub.slice("/workspace".length) || "/";
  if (sub.includes("..") || sub.includes("\\")) return root;
  const resolved = path.resolve(root, `.${sub.startsWith("/") ? sub : `/${sub}`}`);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return root;
  return resolved;
}

/* ------------------------------------------------------------------ */
/* Cœur d'exécution (spawn nettoyé, timeout dur, sortie plafonnée)     */
/* ------------------------------------------------------------------ */

interface RawOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;
  spawnError: string | null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runProcess(params: {
  binary: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<RawOutcome> {
  return new Promise((resolve) => {
    const outcome: RawOutcome = { stdout: "", stderr: "", exitCode: null, timedOut: false, outputTruncated: false, spawnError: null };
    let settled = false;

    let child: ChildProcess;
    try {
      // detached: NOUVEAU groupe de processus → le kill du tree est possible
      // (kill -pgid) même si la commande spawn elle-même des enfants.
      child = spawn(params.binary, params.args, {
        cwd: params.cwd,
        env: MINIMAL_ENV,
        stdio: ["ignore", "pipe", "pipe"] as const,
        detached: true,
      });
    } catch (error) {
      outcome.spawnError = error instanceof Error ? error.message : String(error);
      resolve(outcome);
      return;
    }

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(fallbackTimer);
      resolve(outcome);
    };

    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Groupe déjà mort ou non supporté : kill direct en repli.
        child.kill("SIGKILL");
      }
    };

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killed = false;

    const collect = (stream: NodeJS.ReadableStream, kind: "stdout" | "stderr") => {
      stream.on("data", (chunk: Buffer) => {
        if (kind === "stdout") {
          if (stdoutBytes < params.maxOutputBytes) {
            outcome.stdout += chunk.toString("utf8");
            stdoutBytes = Buffer.byteLength(outcome.stdout);
          }
        } else if (stderrBytes < params.maxOutputBytes) {
          outcome.stderr += chunk.toString("utf8");
          stderrBytes = Buffer.byteLength(outcome.stderr);
        }
        if (!killed && (stdoutBytes >= params.maxOutputBytes || stderrBytes >= params.maxOutputBytes)) {
          killed = true;
          outcome.outputTruncated = true;
          killTree();
        }
      });
    };
    if (child.stdout) collect(child.stdout, "stdout");
    if (child.stderr) collect(child.stderr, "stderr");

    const timer = setTimeout(() => {
      outcome.timedOut = true;
      killTree();
    }, params.timeoutMs);

    // Ceinture de sécurité : si le close n'arrive pas (zombie/edge), le
    // résultat est rendu au pire 2 s après le kill.
    const fallbackTimer = setTimeout(() => finish(), params.timeoutMs + 2_000);

    child.on("error", (error) => {
      outcome.spawnError = error.message;
      finish();
    });
    child.on("close", (code) => {
      outcome.exitCode = code;
      finish();
    });
  });
}

/* ------------------------------------------------------------------ */
/* Point d'entrée                                                      */
/* ------------------------------------------------------------------ */

function rejectedResult(stderr: string, durationMs: number): ServerlessExecutionOutput {
  return { success: false, stdout: "", stderr, exitCode: 126, durationMs, mode: "serverless", timedOut: false, outputTruncated: false };
}

/**
 * Exécute RÉELLEMENT un job (bash / node / python) en-processus, dans la
 * microVM serverless, avec tous les garde-fous documentés en tête de module.
 * Ne LÈVE jamais pour une cause de politique/commande : le rejet est un
 * résultat honnête (exitCode 126) — seules les erreurs de programmation
 * (workspace impossible à créer) remontent à l'appelant.
 */
export async function runServerlessExecution(job: SandboxJob): Promise<ServerlessExecutionOutput> {
  const startedAt = Date.now();
  const limits = clampLimits(job);

  // Deny-list durcie — réévaluée ici même si l'appelant l'a déjà faite
  // (défense en profondeur : AUCUNE exécution shell sans elle).
  if (job.runtime === "shell") {
    const denial = findTerminalDenial(job.code);
    if (!job.code.trim()) return rejectedResult("Terminal command cannot be empty.", 0);
    if (job.code.length > TERMINAL_MAX_COMMAND_LENGTH) return rejectedResult("Terminal command is too large.", 0);
    if (denial) {
      return rejectedResult(`Terminal command rejected by Gen3ia safety policy. (motif : ${denial.label})`, 0);
    }
  }

  const workspace = await ensureServerlessWorkspace(job.userId);
  const root = path.resolve(workspace.root);
  const cwd = resolveWorkspaceCwd(root, (job.input as { cwd?: unknown } | undefined)?.cwd);
  // Le cwd demandé peut ne pas exister localement (convention Docker) :
  // créé dans le workspace — jamais hors /tmp.
  if (cwd !== root) await mkdir(cwd, { recursive: true, mode: 0o700 }).catch(() => undefined);

  // Parité avec le service Docker : input.json exposé au code exécuté.
  await writeFile(path.join(cwd, "input.json"), JSON.stringify(job.input ?? null), "utf8").catch(() => undefined);

  let binary = "bash";
  let args: string[] = [];
  let scriptFile: string | null = null;

  if (job.runtime === "shell") {
    binary = "bash";
    // Plancher 4 Go : cf. en-tête de module (V8 réserve ~4 Go d'adressage
    // virtuel — un plafond plus bas tuerait `node script.js` au démarrage).
    const shellVirtualKb = Math.max(limits.memoryMb * 1024, NODE_VIRTUAL_ADDRESS_SPACE_KB);
    args = ["--noprofile", "-lc", `ulimit -v ${shellVirtualKb} 2>/dev/null; ${job.code}`];
  } else if (job.runtime === "node") {
    scriptFile = path.join(cwd, `.gen3ia-run-${randomUUID()}.mjs`);
    await writeFile(scriptFile, job.code, "utf8");
    binary = "bash";
    args = [
      "--noprofile",
      "-lc",
      `ulimit -v ${NODE_VIRTUAL_ADDRESS_SPACE_KB} 2>/dev/null; exec ${shellQuote(process.execPath)} --max-old-space-size=${limits.memoryMb} ${shellQuote(scriptFile)}`,
    ];
  } else {
    // python : binaire python3 requis (sinon la chaîne de décision est déjà
    // retombée en simulation — garde de sécurité si appelé directement).
    if (!probeBinary("python3", ["--version"])) {
      return rejectedResult("Python 3 n'est pas disponible dans cet environnement serverless — exécution réelle impossible (la simulation est annoncée par la chaîne de décision).", Date.now() - startedAt);
    }
    scriptFile = path.join(cwd, `.gen3ia-run-${randomUUID()}.py`);
    await writeFile(scriptFile, job.code, "utf8");
    binary = "bash";
    args = ["--noprofile", "-lc", `ulimit -v ${limits.memoryMb * 1024} 2>/dev/null; exec ${shellQuote("python3")} ${shellQuote(scriptFile)}`];
  }

  const raw = await runProcess({ binary, args, cwd, timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxOutputBytes });

  if (scriptFile) await rm(scriptFile, { force: true }).catch(() => undefined);

  const stderrParts: string[] = [];
  if (raw.spawnError) stderrParts.push(`[exécution serverless impossible : ${raw.spawnError}]`);
  if (raw.stderr) stderrParts.push(raw.stderr);
  if (raw.timedOut) stderrParts.push(`[timeout ${limits.timeoutMs} ms — processus tué]`);
  if (raw.outputTruncated) stderrParts.push(`[sortie plafonnée à ${limits.maxOutputBytes} octets — processus tué]`);

  return {
    success: raw.exitCode === 0 && !raw.timedOut && !raw.spawnError,
    stdout: raw.stdout,
    stderr: stderrParts.join("\n"),
    exitCode: raw.exitCode,
    durationMs: Date.now() - startedAt,
    mode: "serverless",
    timedOut: raw.timedOut,
    outputTruncated: raw.outputTruncated,
  };
}
