import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runIsolatedCommand(command: string, args: string[], timeoutMs: number, maxOutputBytes: number) {
  return execFileAsync(command, args, {
    timeout: Math.min(Math.max(timeoutMs, 1000), 120000),
    maxBuffer: Math.min(Math.max(maxOutputBytes, 1024), 5 * 1024 * 1024),
    env: { PATH: process.env.PATH ?? "", HOME: "/tmp" },
  });
}
