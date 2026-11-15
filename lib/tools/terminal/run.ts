import { z } from "zod";

import { executeAgentTerminal } from "@/lib/agents/runtime/agent-terminal";
import {
  isTerminalSessionActive,
  recordTerminalExecution,
} from "@/lib/agents/runtime/terminal-sessions";
import type { ToolDefinition } from "../types";

/**
 * OUTIL AGENT `terminal.run` (Task 122 — terminal intégré FONCTIONNEL).
 *
 * Jusqu'ici le terminal agent (`terminal.execute`) était réservé au flux
 * d'exécution autorisé et le registre d'outils n'exposait AUCUN terminal
 * exécutable : le planificateur voyait une capacité terminal mais aucun
 * exécuteur réel n'était fourni à l'agent. `terminal.run` comble ce trou :
 *
 *  - EXÉCUTION RÉELLE : la commande part dans la même chaîne sécurisée que
 *    le terminal agent (executeAgentTerminal → Docker > serverless >
 *    simulation) — sandbox Docker si déployée, sinon exécution réelle
 *    en-processus dans la microVM serverless (env nettoyé, cwd /tmp, ulimit,
 *    timeout dur, sortie plafonnée), sinon simulation annoncée. Le MODE est
 *    renvoyé à l'agent.
 *  - DENY-LIST PARTAGÉE : lib/sandbox/policy.ts (réévaluée avant tout spawn).
 *  - LIMITES : bornes temps/mémoire/sortie identiques au terminal agent.
 *  - SESSIONS D'AUDIT : chaque exécution est journalisée dans la session
 *    terminal (piste d'audit + flux temps réel du Workshop IDE), en fail-soft
 *    — un échec d'audit n'interrompt JAMAIS l'agent.
 *
 * POLITIQUE D'APPROBATION (directive 10-10 — voir
 * lib/agents/approval-policy.ts INTERNAL_ACTION_TOOLS) : `terminal.run` est
 * un outil INTERNE, comme files. Il opère UNIQUEMENT sur l'infrastructure
 * Gen3ia (microVM éphémère, workspace /tmp), l'environnement du subprocess
 * est NETTOYÉ (aucun secret utilisateur hérité), aucune app externe n'est
 * ciblée et les commandes dangereuses sont rejetées AVANT exécution par la
 * politique partagée. Les règles d'approbation n'exigent une validation
 * humaine que pour les actions manipulant des secrets utilisateurs — ce
 * n'est pas le cas ici → aucune carte de validation, exécution directe
 * (facturation et audit restent appliqués par la plateforme).
 */

const inputSchema = z.object({
  command: z.string().min(1).max(50_000),
  cwd: z.string().max(500).optional(),
  runtime: z.enum(["node", "python"]).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  memoryMb: z.number().int().min(64).max(2_048).optional(),
  terminalSessionId: z.string().min(1).max(128).optional(),
  conversationId: z.string().min(1).max(128).optional(),
});

export const terminalRunTool: ToolDefinition = {
  id: "terminal.run",
  name: "terminal.run",
  description:
    "Run a REAL command in the Gen3ia agent terminal (isolated execution: cleaned environment, /tmp workspace, hardened deny-list, time/memory/output limits). Returns stdout, stderr, exitCode and the HONEST execution mode — sandbox Docker when deployed, otherwise real in-process serverless execution, otherwise an announced simulation.",
  category: "code",
  risk: "medium",
  inputSchema,
  execute: async (input, context) => {
    const parsed = inputSchema.parse(input);

    // Session arrêtée par l'utilisateur : plus AUCUNE nouvelle commande.
    if (parsed.terminalSessionId) {
      const accepting = await isTerminalSessionActive(context.userId, parsed.terminalSessionId);
      if (!accepting) {
        throw new Error("La session terminal a été arrêtée par l'utilisateur — aucune nouvelle commande n'est acceptée.");
      }
    }

    const execution = await executeAgentTerminal({
      userId: context.userId,
      executionId: context.executionId ?? context.agentId ?? "terminal-run",
      runtime: parsed.runtime,
      command: parsed.command,
      cwd: parsed.cwd,
      timeoutMs: parsed.timeoutMs,
      memoryMb: parsed.memoryMb,
    });

    // Piste d'audit + flux temps réel du Workshop IDE — fail-soft.
    await recordTerminalExecution({
      userId: context.userId,
      sessionId: parsed.terminalSessionId,
      projectId: context.projectId,
      conversationId: parsed.conversationId,
      command: parsed.command,
      success: execution.success,
      stdout: execution.stdout,
      stderr: execution.stderr,
      exitCode: execution.exitCode ?? undefined,
      durationMs: execution.durationMs,
      mode: execution.mode,
      engine: execution.simulation?.engine ?? null,
    }).catch(() => undefined);

    return execution;
  },
};
