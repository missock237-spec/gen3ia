import { randomUUID } from "node:crypto";

import {
  createExecutionWorkspace,
} from "@/lib/execution/workspace";
import {
  assertWorkspaceOwner,
  registerWorkspace,
} from "@/lib/execution/workspace-registry";
import { executeAgentTerminal } from "./agent-terminal";
import {
  ensureTerminalSession,
  recordTerminalExecution,
  type TerminalSession,
} from "./terminal-sessions";

/**
 * TERMINAL UTILISATEUR (terminal intégré avancé).
 *
 * Jusqu'ici le terminal était réservé aux agents : l'utilisateur observait
 * en lecture seule. Ce module ouvre l'EXÉCUTION DIRECTE à tout utilisateur
 * authentifié, dans SON workspace d'exécution personnel :
 *  - workspace persistant 24 h (registre Firestore `executionWorkspaces`,
 *    propriété ownerId exacte — anti-énumération par construction) ;
 *  - mêmes garde-fous que le terminal agent : deny-list de commandes
 *    dangereuses, bornes temps/mémoire/sortie, sandbox Docker si déployée
 *    sinon simulation annoncée honnêtement (mode renvoyé au client) ;
 *  - session terminal dédiée (scope `workspace:<id>`) : audit + masquage
 *    de secrets + rétention, alimentant le Workshop IDE en temps réel ;
 *  - facturation : aucune (exécution utilisateur directe, hors agent) —
 *    le métrage IA reste celui des exécutions d'agents.
 */

export interface UserTerminalResult {
  workspace: { id: string; reused: boolean };
  session: TerminalSession | null;
  execution: Awaited<ReturnType<typeof executeAgentTerminal>>;
}

/** Clé de workspace STABLE par utilisateur : le même hash → le même
 * répertoire /tmp déterministe (rattachement sur la même VM) et le même
 * identifiant de workspace dans le registre (TTL prolongé à chaque usage). */
function userWorkspaceExecutionKey(userId: string): string {
  return `user-terminal:${userId}`;
}

export async function executeUserTerminalCommand(params: {
  userId: string;
  command: string;
  workspaceId?: string;
  timeoutMs?: number;
  memoryMb?: number;
}): Promise<UserTerminalResult> {
  const command = params.command.trim();
  if (!command) throw new Error("Commande vide.");

  // 1. Workspace : réutilisation propriétaire OU création du workspace
  //    personnel persistant (24 h, prolongé à chaque commande).
  let workspaceId = params.workspaceId?.trim() ?? "";
  let reused = false;
  if (workspaceId) {
    await assertWorkspaceOwner(workspaceId, params.userId); // "Workspace access denied" si non propriétaire
    reused = true;
  } else {
    const created = await createExecutionWorkspace(userWorkspaceExecutionKey(params.userId));
    workspaceId = created.id;
  }
  // Upsert TTL : chaque usage prolonge la fenêtre de 24 h (fail-soft).
  await registerWorkspace(
    { id: workspaceId, root: "" },
    params.userId,
    userWorkspaceExecutionKey(params.userId),
  ).catch(() => undefined);

  // 2. Session terminal dédiée (audit + flux IDE), scope workspace.
  const session = await ensureTerminalSession({ userId: params.userId, workspaceId });

  // 3. Exécution via la MÊME chaîne sécurisée que les agents.
  const executionId = randomUUID();
  const startedAt = Date.now();
  let execution: Awaited<ReturnType<typeof executeAgentTerminal>>;
  try {
    execution = await executeAgentTerminal({
      userId: params.userId,
      executionId,
      runtime: "node",
      command,
      timeoutMs: params.timeoutMs,
      memoryMb: params.memoryMb,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue";
    await recordTerminalExecution({
      userId: params.userId,
      workspaceId,
      sessionId: session?.id,
      command,
      success: false,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
  // 4. Journal d'exécution (fail-soft côté sessions — jamais bloquant).
  const stderr = typeof execution.stderr === "string" ? execution.stderr : "";
  const stdout = typeof execution.stdout === "string" ? execution.stdout : "";
  await recordTerminalExecution({
    userId: params.userId,
    workspaceId,
    sessionId: session?.id,
    command,
    success: execution.exitCode === 0,
    stdout,
    stderr,
    exitCode: execution.exitCode ?? undefined,
    durationMs: execution.durationMs ?? Date.now() - startedAt,
    mode: execution.mode,
    engine: execution.simulation?.engine ?? null,
  });

  return {
    workspace: { id: workspaceId, reused },
    session,
    execution,
  };
}
