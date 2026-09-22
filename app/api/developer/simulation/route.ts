import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireCodeAgentOwner } from "@/lib/agents/code-agent-guard";
import { rateLimit } from "@/lib/security/rate-limit";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { simulateSandboxJob } from "@/lib/sandbox/simulation";

export const runtime = "nodejs";

/**
 * Système de simulation de code de l'agent de code.
 *
 * Simulation pure, SANS exécution side-effect : Node → VM V8 restreinte
 * (contexte gelé, timeout natif) ; Python/shell → analyse statique
 * structurée. Le moteur utilisé est annoncé dans la réponse.
 */
const SimulationSchema = z.object({
  runtime: z.enum(["node", "python", "shell"]),
  code: z.string().min(1).max(500_000),
  input: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const guard = await requireCodeAgentOwner(request);
    if ("forbidden" in guard) return guard.forbidden;

    const limit = rateLimit(`dev-simulation:${guard.user.uid}`, { limit: 60, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Trop de simulations rapprochées. Réessayez dans quelques instants." }, { status: 429 });
    }

    const parsed = SimulationSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Requête de simulation invalide.", issues: parsed.error.flatten() }, { status: 400 });
    }

    const result = await simulateSandboxJob({
      executionId: randomUUID(),
      userId: guard.user.uid,
      runtime: parsed.data.runtime,
      code: parsed.data.code,
      input: parsed.data.input,
      limits: { timeoutMs: parsed.data.timeoutMs ?? 5_000, memoryMb: 512, cpu: 1, maxOutputBytes: 1_000_000 },
      network: "none",
    });

    return NextResponse.json({
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      mode: result.mode,
      simulation: result.simulation ?? null,
    });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Simulation indisponible."), { status: errorStatus(error) });
  }
}
