import { runSandboxOrSimulation } from "@/lib/sandbox/simulation";
import type { SandboxLimits } from "@/lib/sandbox/types";

const MAX_COMMAND_LENGTH = 50_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const WORKSPACE_ROOT = "/workspace";
export interface AgentTerminalRequest { userId: string; executionId: string; runtime?: "node" | "python"; command: string; cwd?: string; timeoutMs?: number; memoryMb?: number; }
const DENIED_PATTERNS = [
  /(^|\s)(sudo|su)\b/i,
  /rm\s+(?:-[^\s]*\s+)*-?rf\s+\//i,
  /mkfs(?:\.[a-z0-9]+)?\b/i,
  /:\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;\s*:/,
  /(?:curl|wget)\s+[^\n]*\|\s*(?:ba)?sh/i,
  /(?:shutdown|reboot|poweroff|halt)\b/i,
  /\bdocker(?:\s|$)/i,
  /\b(?:mount|umount)\b/i,
  /chmod\s+777/i,
  /\b(?:nc|netcat|socat)\b/i,
  /\/proc\/|\/sys\/|\/dev\/mem|\/dev\/kmem/i,
];
function assertCommandSafe(command: string) {
  if (!command.trim()) throw new Error("Terminal command cannot be empty.");
  if (command.length > MAX_COMMAND_LENGTH) throw new Error("Terminal command is too large.");
  if (DENIED_PATTERNS.some((pattern) => pattern.test(command))) throw new Error("Terminal command rejected by Gen3ia safety policy.");
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
  // Terminal : sandbox Docker si déployé, sinon dry-run simulé — le mode
  // est annoncé dans le résultat (aucune prétention d'exécution réelle).
  return runSandboxOrSimulation({ executionId: params.executionId, userId: params.userId, runtime: "shell", code: params.command, input: { cwd }, limits, network: "none" });
}
