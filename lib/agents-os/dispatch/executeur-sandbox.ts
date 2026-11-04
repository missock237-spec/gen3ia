import "server-only";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * AGENTS-OS — EXÉCUTEUR SANDBOX (Module 2 : dispatch zero-cloud).
 *
 * Exécute un script JavaScript fourni par l'appelant dans un processus
 * enfant ISOLÉ, avec quatre murs :
 *
 *   1. ISOLEMENT — processus node séparé, budget heap plafonné
 *      (--max-old-space-size), répertoire de travail TEMPORAIRE jetable ;
 *      mode Docker optionnel (docker run --rm --network none --memory) si le
 *      binaire est présent et DOCKER_SANDBOX=1 — l'isolement processus reste
 *      la voie par défaut (VPS 2 Go sans daemon Docker garanti) ;
 *   2. TEMPS — timeout dur : SIGTERM puis SIGKILL après grâce de 3 s ;
 *   3. TAILLE — stdout/stderr bornés en mémoire (buffering plafonné) ;
 *   4. PROPRIÉTÉ — le répertoire temporaire est détruit dans `finally` :
 *      AUCUN fichier temporaire ne survit à l'appel (cleanup garanti même en
 *      cas de timeout ou de crash).
 *
 * Le script s'exécute via un petit préambule qui capture son résultat :
 * il doit appeler `emettre(valeur)` (ou `return` dans une IIFE) — tout
 * stdout autre que la balise de résultat est renvoyé comme logs.
 */

export interface ConfigSandbox {
  /** Timeout d'exécution (ms, défaut 30 000, plafond 120 000). */
  readonly timeoutMs?: number;
  /** Budget heap du processus enfant en Mo (défaut 256). */
  readonly heapMo?: number;
  /** Taille max du script (caractères, défaut 200 000). */
  readonly tailleScriptMax?: number;
  /** Forcer le mode docker si disponible (défaut : env DOCKER_SANDBOX=1). */
  readonly prefererDocker?: boolean;
}

export interface ResultatSandbox {
  readonly ok: boolean;
  /** Valeur émise par le script (emettre()) — JSON parsé si possible. */
  readonly resultat?: unknown;
  /** Sortie standard hors balise de résultat (logs du script, tronqués). */
  readonly logs: string;
  readonly stderr: string;
  readonly codeSortie: number | null;
  readonly signal: string | null;
  readonly dureeMs: number;
  readonly timeoutAtteint: boolean;
  readonly mode: "processus" | "docker";
  readonly erreur?: string;
  /** Répertoire temporaire supprimé (toujours true à la sortie). */
  readonly nettoye: boolean;
}

const BALISE_DEBUT = "__GEN3IA_RESULTAT__";
const PLAFOND_SORTIE = 64_000;

export class ExecuteurSandbox {
  private readonly timeoutMs: number;
  private readonly heapMo: number;
  private readonly tailleScriptMax: number;
  private readonly prefererDocker: boolean;

  constructor(config: ConfigSandbox = {}) {
    this.timeoutMs = Math.min(120_000, Math.max(1_000, config.timeoutMs ?? 30_000));
    this.heapMo = Math.min(1_024, Math.max(64, config.heapMo ?? 256));
    this.tailleScriptMax = Math.max(1, config.tailleScriptMax ?? 200_000);
    this.prefererDocker = config.prefererDocker ?? process.env.DOCKER_SANDBOX === "1";
  }

  /** Exécute le script dans la sandbox. Ne lève JAMAIS. */
  async executer(script: string, donnees?: unknown): Promise<ResultatSandbox> {
    const debut = Date.now();
    if (typeof script !== "string" || script.trim().length === 0) {
      return this.echec("script vide ou absent", debut, "processus");
    }
    if (script.length > this.tailleScriptMax) {
      return this.echec(`script dépasse ${this.tailleScriptMax} caractères`, debut, "processus");
    }

    const repertoire = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agents-os-sandbox-"));
    try {
      const cheminScript = path.join(repertoire, "tache.js");
      const cheminDonnees = path.join(repertoire, "donnees.json");
      const cheminPreAmble = path.join(repertoire, "preamble.js");

      // Préambule : pont emettre() → balise unique sur stdout (parse côté père).
      await fs.promises.writeFile(cheminPreAmble, PREAMBULE, "utf8");
      await fs.promises.writeFile(
        cheminScript,
        `const donnees = require(${JSON.stringify(cheminDonnees)});\n\n${script}\n`,
        "utf8",
      );
      await fs.promises.writeFile(cheminDonnees, JSON.stringify(donnees ?? {}), "utf8");

      const useDocker = this.prefererDocker && (await dockerDisponible());
      const argv = useDocker
        ? ["docker", "run", "--rm", "--network", "none", "--memory", `${this.heapMo}m`, "--cpus", "0.5", "-v", `${repertoire}:/travail:ro`, "-w", "/travail", "node:20-alpine", "node", "/travail/preamble.js"]
        : ["node", `--max-old-space-size=${this.heapMo}`, cheminPreAmble];

      const execution = await this.spawnPlafonne(argv, useDocker ? "docker" : "processus");
      return this.parserSortie(execution, Date.now() - debut, useDocker ? "docker" : "processus");
    } catch (erreur) {
      return this.echec(erreur instanceof Error ? erreur.message : String(erreur), debut, "processus");
    } finally {
      // Garde-fou 4 : destruction du répertoire — JAMAIS contournée.
      try {
        await fs.promises.rm(repertoire, { recursive: true, force: true });
      } catch {
        /* rm force ne lève normalement pas ; sinon : rien à faire de plus. */
      }
    }
  }

  private spawnPlafonne(argv: readonly string[], mode: "processus" | "docker"): Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null; timeoutAtteint: boolean }> {
    return new Promise((resoudre) => {
      // Typage explicite ChildProcess : l'inférence sur l'overload spawn +
      // stdio tuple produit une intersection `never` sous TS 6 (stdin
      // incompatibles) et des paramètres implicites any sur « close ».
      const enfant: ChildProcess = spawn(argv[0], argv.slice(1), {
        cwd: os.tmpdir(),
        stdio: ["ignore", "pipe", "pipe"],
        env: mode === "docker" ? { PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production" } : { ...process.env, NODE_ENV: "production" },
      });

      let stdout = "";
      let stderr = "";
      let timeoutAtteint = false;
      let fini = false;

      // stdio "pipe" garanti non nul à la création — garde défensive ?.
      enfant.stdout?.on("data", (d: Buffer) => {
        if (stdout.length < PLAFOND_SORTIE) stdout += d.toString("utf8");
      });
      enfant.stderr?.on("data", (d: Buffer) => {
        if (stderr.length < PLAFOND_SORTIE) stderr += d.toString("utf8");
      });

      const minuteur = setTimeout(() => {
        if (fini) return;
        timeoutAtteint = true;
        enfant.kill("SIGTERM");
        setTimeout(() => {
          if (!fini) enfant.kill("SIGKILL");
        }, 3_000);
      }, this.timeoutMs);
      minuteur.unref?.();

      enfant.on("error", (erreur) => {
        if (fini) return;
        fini = true;
        clearTimeout(minuteur);
        resoudre({ stdout, stderr: `${stderr}\n${erreur.message}`, code: -1, signal: null, timeoutAtteint });
      });

      enfant.on("close", (code, signal) => {
        if (fini) return;
        fini = true;
        clearTimeout(minuteur);
        resoudre({ stdout, stderr, code, signal, timeoutAtteint });
      });
    });
  }

  /** Parse la sortie : balise résultat → JSON, sinon logs bruts. */
  private parserSortie(
    execution: { stdout: string; stderr: string; code: number | null; signal: string | null; timeoutAtteint: boolean },
    dureeMs: number,
    mode: "processus" | "docker",
  ): ResultatSandbox {
    const premiereBalise = execution.stdout.indexOf(BALISE_DEBUT);
    const logs = (premiereBalise >= 0 ? execution.stdout.slice(0, premiereBalise) : execution.stdout).slice(0, 4_000).trimEnd();
    // Dernière balise gagnante : le dernier appel emettre() est le résultat.
    const index = execution.stdout.lastIndexOf(BALISE_DEBUT);
    const brut = index >= 0 ? execution.stdout.slice(index + BALISE_DEBUT.length).trim() : "";

    if (execution.timeoutAtteint) {
      return {
        ok: false, logs, stderr: execution.stderr.slice(0, 4_000), codeSortie: execution.code, signal: execution.signal,
        dureeMs, timeoutAtteint: true, mode, erreur: `timeout sandbox (${this.timeoutMs} ms) — processus tué`, nettoye: true,
      };
    }
    if (!brut) {
      return {
        ok: false, logs, stderr: execution.stderr.slice(0, 4_000), codeSortie: execution.code, signal: execution.signal,
        dureeMs, timeoutAtteint: false, mode,
        erreur: "aucun résultat émis — le script doit appeler emettre(valeur)", nettoye: true,
      };
    }
    try {
      return {
        ok: true, resultat: JSON.parse(brut), logs, stderr: execution.stderr.slice(0, 4_000), codeSortie: execution.code,
        signal: execution.signal, dureeMs, timeoutAtteint: false, mode, nettoye: true,
      };
    } catch {
      return {
        ok: false, logs, stderr: execution.stderr.slice(0, 4_000), codeSortie: execution.code, signal: execution.signal,
        dureeMs, timeoutAtteint: false, mode, erreur: "résultat non sérialisable en JSON", nettoye: true,
      };
    }
  }

  private echec(erreur: string, debut: number, mode: "processus" | "docker"): ResultatSandbox {
    return {
      ok: false, logs: "", stderr: "", codeSortie: null, signal: null,
      dureeMs: Date.now() - debut, timeoutAtteint: false, mode, erreur, nettoye: true,
    };
  }
}

/** Docker présent ET fonctionnel ? (sonde légère, mise en cache par appel.) */
async function dockerDisponible(): Promise<boolean> {
  return new Promise((resoudre) => {
    const enfant = spawn("docker", ["info", "--format", "ok"], { stdio: "ignore", timeout: 3_000 });
    enfant.on("close", (code) => resoudre(code === 0));
    enfant.on("error", () => resoudre(false));
  });
}

/**
 * Préambule injecté : le script utilisateur tourne DERRIÈRE un bridge
 * minimal. `emettre(valeur)` sérialise la valeur vers stdout sous balise.
 * `console.log` reste disponible (logs) mais n'est JAMAIS confondu avec le
 * résultat grâce à la balise.
 */
const PREAMBULE = `
"use strict";
const BALISE = ${JSON.stringify(BALISE_DEBUT)};
// IMPORTANT : emettre vit sur globalThis — un module requis (tache.js) a
// son propre scope CommonJS et ne voit PAS les const locales du préambule.
globalThis.emettre = function emettre(valeur) {
  process.stdout.write(BALISE + JSON.stringify(valeur));
};
try {
  require(${JSON.stringify("./tache.js")});
} catch (erreur) {
  process.stderr.write(String(erreur && erreur.stack ? erreur.stack : erreur));
  process.exit(1);
}
`;
