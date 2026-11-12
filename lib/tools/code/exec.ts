import "server-only";

import { Worker } from "node:worker_threads";

import { z } from "zod";

import type { ToolDefinition } from "../types";

/**
 * OUTIL `code.exec` — exécution JavaScript/TypeScript-lite SANDBOXÉE.
 *
 * Architecture à deux couches (la plus contenue possible en-processus) :
 *  1. THREAD DE TRAVAIL isolé (node:worker_threads, mode eval) : une fuite
 *     ou un crash du code utilisateur ne peut JAMAIS atteindre le processus
 *     serveur — un thread qui crève meurt seul et l'outil restitue l'erreur
 *     honnêtement. Limite mémoire dure (resourceLimits).
 *  2. MACHINE VIRTUELLE durcie (node:vm) À L'INTÉRIEUR du thread :
 *     - sandbox à prototype NUL (Object.create(null)) : la chaîne de
 *       recherche des propriétés globales ne peut plus « fuiter » vers les
 *       intrinsèques du domaine hôte (l'évasion classique
 *       `this.constructor.constructor("return process")()` échoue) ;
 *     - prototypes Object/Function/AsyncFunction/Generator neutralisés
 *       (propriété `constructor` retirée) ;
 *     - `Function`, `eval`, `Promise`, `WeakRef`, `FinalizationRegistry`
 *       masqués — `require`, `process`, `Buffer`, `fs`, timers et accès
 *       réseau sont ABSENTS du contexte ;
 *     - `import()` dynamique refusé AVANT exécution (scan lexical — la vm
 *       renverrait un rejet non géré qui tuerait le thread) ;
 *     - timeout strict via l'option `timeout` de node:vm (le backstop
 *       `worker.terminate()` reste armé si la vm elle-même bloquait).
 *
 * SORTIE BORNÉE : chaque entrée console est plafonnée (1 000 caractères),
 * 200 entrées maximum, drapeau `tronque` honnête.
 *
 * LIMITES HONNÊTES (documentées aussi dans la description de l'outil) :
 * il s'agit d'une sandbox vm MONO-CONTEXTE synchrone, PAS d'un isolat type
 * gVisor/microVM. Les fonctions async créent des promesses internes dont
 * les rejets sont abandonnés à la fin de l'évaluation (aucun micro-timer
 * n'est exposé) ; le code est purement synchrone par conception.
 */

const TIMEOUT_PAR_DEFAUT_MS = 2_000;
const TIMEOUT_MAX_MS = 2_000;
const CODE_MAX_CARACTERES = 100_000;
const ENTREES_SORTIE_MAX = 200;
const CARACTERES_ENTREE_MAX = 1_000;
const MEMOIRE_WORKER_MO = 128;

/** Détection lexicale de `import(...)` dynamique (mot-clé, pas une propriété). */
const REGEX_IMPORT_DYNAMIQUE = /(?<![\w$.])import\s*\(/;

const EntreeCodeExec = z.object({
  code: z.string().min(1).max(CODE_MAX_CARACTERES),
  timeoutMs: z.number().int().min(100).max(TIMEOUT_MAX_MS).default(TIMEOUT_PAR_DEFAUT_MS),
});

export interface SortieCodeExec {
  succes: boolean;
  /** Valeur de complétion du dernier état (sérialisée JSON, ou null). */
  valeur?: unknown;
  /** Lignes capturées de console.log / console.info / console.debug. */
  stdout: string[];
  /** Lignes capturées de console.warn / console.error / console.trace. */
  stderr: string[];
  /** Vrai si la sortie console a dépassé les bornes (contenu non restitué). */
  tronque: boolean;
  /** Vrai si l'exécution a été interrompue par le timeout strict. */
  timeout?: boolean;
  /** Erreur honnête (syntaxe, évasion bloquée, crash du thread, timeout…). */
  erreur?: string;
  dureeMs: number;
  moteur: "worker_vm_durci";
}

/**
 * Amorçage exécuté DANS la vm avant le code utilisateur. Les constantes de
 * borne sont interpolées (elles ne vivent pas dans la vm). Aucune référence
 * à une fonction hôte n'est exposée au code utilisateur.
 */
const AMORCE_SANDBOX = `
(function () {
  var MAX_ENTREES = ${ENTREES_SORTIE_MAX};
  var MAX_CARACT = ${CARACTERES_ENTREE_MAX};
  var tuer = function (o) {
    if (!o || typeof o !== "object") return;
    try { Object.defineProperty(o, "constructor", { value: undefined, writable: false, enumerable: false, configurable: false }); } catch (e) {}
  };
  tuer(Object.prototype); tuer(Function.prototype);
  try { tuer(Object.getPrototypeOf(async function () {})); } catch (e) {}
  try { tuer(Object.getPrototypeOf(function* () {})); } catch (e) {}
  try { tuer(Object.getPrototypeOf(async function* () {})); } catch (e) {}
  this.Function = undefined;
  this.eval = undefined;
  this.Promise = undefined;
  this.WeakRef = undefined;
  this.FinalizationRegistry = undefined;
  var jo = this.__journal;
  delete this.__journal;
  var fmt = function (a) {
    return Array.from(a).map(function (v) {
      try { return typeof v === "string" ? v : JSON.stringify(v) ?? String(v); } catch (e2) { return String(v); }
    }).join(" ");
  };
  var ecrire = function (cible, a) {
    var s = fmt(a);
    if (jo[cible].length < MAX_ENTREES) {
      jo[cible].push(s.length > MAX_CARACT ? s.slice(0, MAX_CARACT) + "\\u2026" : s);
    } else { jo.tronque = true; }
  };
  this.console = {
    log: function () { ecrire("stdout", arguments); },
    info: function () { ecrire("stdout", arguments); },
    debug: function () { ecrire("stdout", arguments); },
    warn: function () { ecrire("stderr", arguments); },
    error: function () { ecrire("stderr", arguments); },
    trace: function () { ecrire("stderr", arguments); },
  };
})();
`;

/**
 * Code du thread de travail (mode eval, CommonJS). Il reçoit via workerData :
 *  - code : le code utilisateur ;
 *  - timeoutMs : timeout strict de la vm ;
 *  - amorce : le script d'amorçage (voir AMORCE_SANDBOX).
 * Il publie UNIQUEMENT un message borné, puis se termine (process.exit(0)) —
 * aucun objet hôte vivant ne traverse la frontière après coup.
 */
const CODE_WORKER = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const journal = { stdout: [], stderr: [], tronque: false };
const sandbox = Object.create(null);
sandbox.__journal = journal;
const ctx = vm.createContext(sandbox);
vm.runInContext(workerData.amorce, ctx, { timeout: 500 });
try {
  const valeur = vm.runInContext(workerData.code, ctx, { timeout: workerData.timeoutMs });
  let valeurSerialisee = null;
  if (valeur !== undefined) {
    try {
      valeurSerialisee = JSON.parse(JSON.stringify(valeur, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
    } catch (e) { valeurSerialisee = String(valeur); }
    if (typeof valeur === "function" && valeurSerialisee && typeof valeurSerialisee === "object" && Object.keys(valeurSerialisee).length === 0) {
      valeurSerialisee = String(valeur);
    }
  }
  parentPort.postMessage({
    succes: true,
    valeur: valeurSerialisee,
    stdout: journal.stdout,
    stderr: journal.stderr,
    tronque: journal.tronque,
  });
} catch (e) {
  const message = String((e && e.message) || e);
  parentPort.postMessage({
    succes: false,
    erreur: message.slice(0, 2000),
    timeout: /timed out/i.test(message),
    stdout: journal.stdout,
    stderr: journal.stderr,
    tronque: journal.tronque,
  });
} finally { process.exit(0); }
`;

interface MessageWorker {
  succes: boolean;
  valeur?: unknown;
  stdout: string[];
  stderr: string[];
  tronque: boolean;
  erreur?: string;
  timeout?: boolean;
}

/** Exécute le code utilisateur dans le thread isolé + vm durcie. */
async function executerDansWorker(code: string, timeoutMs: number): Promise<MessageWorker> {
  const worker = new Worker(CODE_WORKER, {
    eval: true,
    workerData: { code, timeoutMs, amorce: AMORCE_SANDBOX },
    resourceLimits: { maxOldGenerationSizeMb: MEMOIRE_WORKER_MO, maxYoungGenerationSizeMb: 32, codeRangeSizeMb: 16 },
  });

  const resultat = await new Promise<MessageWorker>((resoudre) => {
    let resolu = false;
    const finir = (resultat: MessageWorker) => {
      if (resolu) return;
      resolu = true;
      resoudre(resultat);
    };
    // Backstop dur : même si la vm devait ne pas honorer son timeout, le
    // thread est tué et un résultat honnête est restitué.
    const minuteur = setTimeout(() => {
      void worker.terminate();
      finir({
        succes: false,
        timeout: true,
        erreur: `Exécution interrompue après ${timeoutMs} ms (timeout strict).`,
        stdout: [],
        stderr: [],
        tronque: false,
      });
    }, timeoutMs + 300);
    worker.on("message", (message: MessageWorker) => {
      clearTimeout(minuteur);
      finir(message);
    });
    worker.on("error", (erreur: Error) => {
      clearTimeout(minuteur);
      finir({
        succes: false,
        erreur: `Le thread sandbox a échoué : ${String(erreur.message).slice(0, 500)}`,
        stdout: [],
        stderr: [],
        tronque: false,
      });
    });
    worker.on("exit", (codeSortie: number) => {
      clearTimeout(minuteur);
      finir({
        succes: false,
        erreur: codeSortie === 0 ? "Le thread sandbox s'est terminé sans publier de résultat." : `Le thread sandbox s'est terminé anormalement (code ${codeSortie}).`,
        stdout: [],
        stderr: [],
        tronque: false,
      });
    });
  }).finally(() => {
    void worker.terminate();
  });

  return resultat;
}

export const outilCodeExec: ToolDefinition<z.infer<typeof EntreeCodeExec>, SortieCodeExec> = {
  id: "code.exec",
  name: "code.exec",
  description:
    "Exécute un SNIPPET JavaScript SANDBOXÉ (JavaScript pur, synchrone) et renvoie la valeur de complétion + la sortie console capturée (stdout/stderr bornés). " +
    "Input : { code: \"1 + 2 * 3\" | \"[1,2,3].map(n => n*n)\" | \"class P { double(n){return n*2}} new P().double(21)\", timeoutMs?: 100–2000 (défaut 2000) }. " +
    "Sandbox dure : PAS d'accès fs/réseau/process/require/import — les évasions classiques (this.constructor.constructor, Function, eval, process.exit) échouent proprement; timeout strict 2 s; boucle infinie interrompue. " +
    "Limites honnêtes : sandbox vm mono-contexte synchrone (pas un isolat gVisor) — pas de setTimeout, pas d'await au niveau racine, les rejets de promesses async sont abandonnés. " +
    "À utiliser pour calculer, transformer des données, tester une logique — PAS pour lire des fichiers ni appeler des API (utiliser web.http).",
  category: "code",
  risk: "medium",
  inputSchema: EntreeCodeExec,
  async execute(input) {
    const debut = Date.now();
    if (REGEX_IMPORT_DYNAMIQUE.test(input.code)) {
      return {
        succes: false,
        erreur: "Le dynamique import() est interdit dans la sandbox code.exec (aucun accès module/fs/réseau). Réécris le code sans import.",
        stdout: [],
        stderr: [],
        tronque: false,
        dureeMs: Date.now() - debut,
        moteur: "worker_vm_durci",
      };
    }
    const resultat = await executerDansWorker(input.code, input.timeoutMs);
    return {
      succes: resultat.succes,
      ...(resultat.valeur !== undefined && resultat.valeur !== null ? { valeur: resultat.valeur } : {}),
      stdout: resultat.stdout ?? [],
      stderr: resultat.stderr ?? [],
      tronque: resultat.tronque ?? false,
      ...(resultat.timeout ? { timeout: true } : {}),
      ...(resultat.erreur ? { erreur: resultat.erreur } : {}),
      dureeMs: Date.now() - debut,
      moteur: "worker_vm_durci",
    };
  },
};
