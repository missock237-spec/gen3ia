import { z } from "zod";
export const SandboxLimitsSchema = z.object({ timeoutMs: z.number().int().min(100).max(120_000), memoryMb: z.number().int().min(64).max(2048), cpu: z.number().min(0.1).max(2), maxOutputBytes: z.number().int().min(1024).max(10_000_000) });
export const SandboxJobSchema = z.object({ executionId: z.string().min(1).max(128), userId: z.string().min(1).max(256), runtime: z.enum(["node", "python", "shell"]), code: z.string().min(1).max(500_000), input: z.unknown().optional(), limits: SandboxLimitsSchema, network: z.enum(["none"]).default("none") });
export type SandboxJob = z.infer<typeof SandboxJobSchema>;
