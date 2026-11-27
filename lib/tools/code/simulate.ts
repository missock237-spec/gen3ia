import "server-only";

import { z } from "zod";

import { simulateSandboxJob } from "@/lib/sandbox/simulation";
import type { SandboxJob } from "@/lib/sandbox/types";
import type { ToolDefinition } from "../types";

/**
 * OUTIL `code.simulate` — SIMULATION HONNÊTE de code, sans effet de bord.
 *
 * v2 (2026-11-27) — SYNCHRONISATION DES REGISTRES (audit outils) : cet outil
 * était annoncé au catalogue GEN3IA_TOOLS depuis sa création mais n'avait
 * NI exécuteur au registre NI définition de sécurité — le planificateur
 * pouvait le planifier, l'exécution levait « Unknown tool security
 * definition » (échec garanti, même classe que les fantômes retirés en
 * it.58 : file.modify, voice.list, phone.call, ui.components, jules.*).
 * Le moteur existait pourtant déjà : lib/sandbox/simulation.ts (analyse
 * statique Node / Python / shell, zéro spawn, zéro écriture). Cet exécuteur
 * le branche — l'outil promis devient une capacité vraie.
 *
 * HONNÊTETÉ : la sortie est une SIMULATION (analyse statique + trace), pas
 * une exécution — le champ `mode` renvoyé vaut toujours « simulation » et
 * la description le rappelle à l'agent. Pour une exécution RÉELLE :
 * `terminal.run` (chaîne Docker → serverless → simulation annoncée) ou
 * `code.exec` (worker + vm durcie).
 */

const CODE_MAX_CARACTERES = 200_000;

const SimulateInput = z.object({
  /** Code à analyser (Node, Python ou shell). */
  code: z.string().min(1).max(CODE_MAX_CARACTERES),
  /** Runtime de la simulation statique (défaut : node). */
  runtime: z.enum(["node", "python", "shell"]).default("node"),
});

export interface SortieCodeSimulate {
  succes: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  dureeMs: number;
  /** Toujours « simulation » : analyse statique, jamais une exécution réelle. */
  mode: "simulation";
  /** Moteur statique employé + trace structurée + avertissements détectés. */
  simulation: {
    engine: "static-node" | "static-python" | "static-shell";
    trace: string[];
    warnings: string[];
  };
}

export const codeSimulateTool: ToolDefinition<z.infer<typeof SimulateInput>, SortieCodeSimulate> = {
  id: "code.simulate",
  name: "code.simulate",
  description:
    "Simule du code SANS effet de bord (analyse statique Node/Python/shell : structure, " +
    "opérations détectées, avertissements de sécurité et de qualité) et renvoie le mode " +
    "réel employé — toujours « simulation ». Pour une exécution réelle : terminal.run " +
    "(Docker → serverless → simulation annoncée) ou code.exec (worker + vm durcie).",
  category: "code",
  risk: "low",
  inputSchema: SimulateInput,
  async execute(input, context): Promise<SortieCodeSimulate> {
    const job: SandboxJob = {
      executionId: `sim_${Date.now().toString(36)}`,
      userId: context.userId || "system",
      runtime: input.runtime,
      code: input.code,
      limits: { timeoutMs: 10_000, memoryMb: 512, cpu: 0.5, maxOutputBytes: 200_000 },
      network: "none",
    };
    const sortie = await simulateSandboxJob(job);
    return {
      succes: sortie.success,
      stdout: sortie.stdout,
      stderr: sortie.stderr,
      exitCode: sortie.exitCode,
      dureeMs: sortie.durationMs,
      mode: "simulation",
      simulation: sortie.simulation ?? {
        engine: input.runtime === "python" ? "static-python" : input.runtime === "shell" ? "static-shell" : "static-node",
        trace: [],
        warnings: [],
      },
    };
  },
};
