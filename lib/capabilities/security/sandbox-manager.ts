/**
 * SANDBOX MANAGER (UCE) — exécution isolée TOUTE façon.
 *
 * Encapsule les deux exécuteurs sandbox existants du dépôt (aucun doublon) :
 *  - `ExecuteurSandbox` (agents-os) : script Node « emettre() », heap/timeout
 *    bornés, réseau NONE, répertoire temporaire détruit ;
 *  - `executeSandbox` (lib/sandbox) : runtimes node/python/shell pour
 *    code.execute utilisateur.
 *
 * L'UCE l'utilise pour : tester des candidats découverts, benchmarker,
 * valider du code généré — jamais d'exécution non isolée de code non fiable.
 */

import "server-only";

import { ExecuteurSandbox, type ResultatSandbox } from "@/lib/agents-os/dispatch/executeur-sandbox";
import { executeSandbox } from "@/lib/sandbox/client";
import type { SandboxLimits, SandboxRuntime } from "@/lib/sandbox/types";

export const LIMITES_SANDBOX_UCE: SandboxLimits = {
  timeoutMs: 15_000,
  memoryMb: 256,
  cpu: 0.5,
  maxOutputBytes: 256_000,
};

export interface ResultatIsolationUce {
  ok: boolean;
  resultat?: unknown;
  journaux: string[];
  dureeMs: number;
  mode: "processus" | "docker" | "sandbox-lib";
  erreur?: string;
}

/**
 * Exécute un script Node DANS LA SANDBOX. Ne lève JAMAIS — retourne un
 * résultat honnête (ok=false + erreur) en cas d'échec d'isolation.
 * Le script doit appeler `emettre(valeur)` pour produire son résultat.
 */
export async function executerEnSandboxUce(
  executionId: string,
  userId: string,
  script: string,
  donnees?: unknown,
  limites: Partial<SandboxLimits> = {},
): Promise<ResultatIsolationUce> {
  const executeur = new ExecuteurSandbox({
    timeoutMs: Math.min(limites.timeoutMs ?? LIMITES_SANDBOX_UCE.timeoutMs, 60_000),
    heapMo: Math.min(limites.memoryMb ?? LIMITES_SANDBOX_UCE.memoryMb, 512),
  });
  const resultat = await executeur.executer(script, donnees);
  return {
    ok: resultat.ok,
    resultat: resultat.resultat,
    journaux: [resultat.logs, resultat.stderr].filter((s) => s.length > 0),
    dureeMs: resultat.dureeMs,
    mode: resultat.mode,
    erreur: resultat.erreur,
  };
}

/**
 * Exécution sandbox générique (runtimes node/python/shell) via lib/sandbox —
 * réservée aux validations UCE qui ont besoin d'un autre runtime que Node.
 */
export async function executerSandboxLib(
  executionId: string,
  userId: string,
  runtime: SandboxRuntime,
  code: string,
  input?: unknown,
  limites: Partial<SandboxLimits> = {},
): Promise<ResultatIsolationUce> {
  try {
    const resultat = await executeSandbox({
      executionId,
      userId,
      runtime,
      code,
      input,
      limits: { ...LIMITES_SANDBOX_UCE, ...limites },
      network: "none",
    });
    return {
      ok: resultat.success,
      journaux: [resultat.stdout, resultat.stderr].filter((s) => s.length > 0),
      dureeMs: resultat.durationMs,
      mode: "sandbox-lib",
      erreur: resultat.success ? undefined : resultat.stderr.slice(0, 500),
    };
  } catch (erreur) {
    return {
      ok: false,
      journaux: [],
      dureeMs: 0,
      mode: "sandbox-lib",
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    };
  }
}

export type { ResultatSandbox };
