import { runSandboxOrSimulation } from "@/lib/sandbox/simulation";
import { assertTerminalCommandSafe } from "@/lib/sandbox/policy";
import type { SandboxLimits } from "@/lib/sandbox/types";

const MAX_OUTPUT_BYTES = 1_000_000;
const WORKSPACE_ROOT = "/workspace";
export interface AgentTerminalRequest { userId: string; executionId: string; runtime?: "node" | "python"; command: string; cwd?: string; timeoutMs?: number; memoryMb?: number; }
// Deny-list : LIBRAIRIE PARTAGÉE lib/sandbox/policy.ts (durcie Task 122 :
// écriture hors /tmp, /proc/self/environ, /var/task, .env*, historiques shell,
// unset/eval d'env, métadonnées cloud, ssh/scp, base64|sh…). Elle est
// réévaluée par le moteur d'exécution juste avant tout spawn — AUCUNE
// exécution ne part sans elle.
function assertCommandSafe(command: string) {
  assertTerminalCommandSafe(command);
}
function assertWorkspaceCwd(cwd: string) {
  if (!cwd.startsWith(`${WORKSPACE_ROOT}/`) && cwd !== WORKSPACE_ROOT) throw new Error("Agent terminal cwd must remain inside /workspace.");
  if (cwd.includes("..") || cwd.includes("\\")) throw new Error("Agent terminal cwd contains an unsafe path.");
}
export async function executeAgentTerminal(params: AgentTerminalRequest) {
  assertCommandSafe(params.command);
  if (!params.userId || !params.executionId) throw new Error("Agent terminal requires an authenticated execution.");
  const cwd = params.cwd ?? WORKSPACE_ROOT;
  assertWorkspaceCwd(cwd);
  const limits: SandboxLimits = { timeoutMs: Math.min(Math.max(params.timeoutMs ?? 30_000, 100), 120_000), memoryMb: Math.min(Math.max(params.memoryMb ?? 512, 64), 2_048), cpu: 1, maxOutputBytes: MAX_OUTPUT_BYTES };
  // Terminal (Task 122) : sandbox Docker si déployé, SINON EXÉCUTION RÉELLE
  // serverless en-processus (env nettoyé, cwd /tmp, ulimit, timeout dur,
  // sortie plafonnée), et simulation annoncée uniquement en cas
  // d'impossibilité locale — le mode réel est TOUJOURS renvoyé au client.
  return runSandboxOrSimulation({ executionId: params.executionId, userId: params.userId, runtime: "shell", code: params.command, input: { cwd }, limits, network: "none" });
}
