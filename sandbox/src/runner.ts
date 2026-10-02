import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxJob } from "./job-schema.js";
interface SandboxResult { success: boolean; stdout: string; stderr: string; exitCode: number | null; durationMs: number; }
function runtimeConfig(runtime: SandboxJob["runtime"]) {
  if (runtime === "python") return { image: "gen3ia-sandbox-python:latest", filename: "main.py", command: ["python", "/workspace/main.py"] };
  if (runtime === "shell") return { image: "gen3ia-sandbox-node:latest", filename: "main.sh", command: ["sh", "/workspace/main.sh"] };
  return { image: "gen3ia-sandbox-node:latest", filename: "main.mjs", command: ["node", "/workspace/main.mjs"] };
}
export async function runSandbox(job: SandboxJob): Promise<SandboxResult> {
  const started = Date.now(); const id = randomUUID(); const workspace = await mkdtemp(join(tmpdir(), `gen3ia-${id}-`));
  try { const config = runtimeConfig(job.runtime); const sourcePath = join(workspace, config.filename); await writeFile(sourcePath, job.code, "utf8"); await writeFile(join(workspace, "input.json"), JSON.stringify(job.input ?? null), "utf8"); const args = ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", `${job.limits.memoryMb}m`, "--cpus", String(job.limits.cpu), "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m", "--mount", `type=bind,src=${workspace},dst=/workspace,readonly`, "--workdir", "/workspace", config.image, ...config.command]; const result = await executeDocker(args, job.limits.timeoutMs); return { ...result, durationMs: Date.now() - started }; } finally { await rm(workspace, { recursive: true, force: true }); }
}
function executeDocker(args: string[], timeoutMs: number): Promise<Omit<SandboxResult, "durationMs">> { return new Promise((resolve) => { const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "", finished = false; const finish = (result: Omit<SandboxResult, "durationMs">) => { if (finished) return; finished = true; resolve(result); }; child.stdout.on("data", (chunk) => { stdout += chunk.toString(); if (Buffer.byteLength(stdout) > 10_000_000) child.kill("SIGKILL"); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); if (Buffer.byteLength(stderr) > 2_000_000) child.kill("SIGKILL"); }); const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ success: false, stdout, stderr: `${stderr}\nSandbox timeout`, exitCode: null }); }, timeoutMs); child.on("close", (code) => { clearTimeout(timer); finish({ success: code === 0, stdout, stderr, exitCode: code }); }); child.on("error", (error) => { clearTimeout(timer); finish({ success: false, stdout, stderr: `${stderr}\n${error.message}`, exitCode: null }); }); }); }
