export type SandboxRuntime = "node" | "python" | "shell";
export interface SandboxLimits { timeoutMs: number; memoryMb: number; cpu: number; maxOutputBytes: number; }
export interface SandboxJob { executionId: string; userId: string; runtime: SandboxRuntime; code: string; input?: unknown; limits: SandboxLimits; network: "none"; }
export interface SandboxResult { success: boolean; stdout: string; stderr: string; exitCode: number | null; durationMs: number; }
