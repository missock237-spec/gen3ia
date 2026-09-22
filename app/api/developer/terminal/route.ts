import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireCodeAgentOwner } from "@/lib/agents/code-agent-guard";
import { rateLimit } from "@/lib/security/rate-limit";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { executeAgentTerminal } from "@/lib/agents/runtime/agent-terminal";
import { isSandboxConfigured } from "@/lib/sandbox/simulation";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Terminal interactif de l'agent de code.
 *
 * Authentification : réservé aux propriétaires d'agent de code
 * (requireCodeAgentOwner). Exécution : sandbox Docker si déployé, sinon
 * dry-run simulé — le mode réel est retourné à l'UI (jamais de fausse
 * prétention d'exécution).
 */
const CommandSchema = z.object({
  command: z.string().min(1).max(50_000),
  cwd: z.string().max(500).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  memoryMb: z.number().int().min(64).max(2_048).optional(),
  runtime: z.enum(["node", "python"]).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const guard = await requireCodeAgentOwner(request);
    if ("forbidden" in guard) return guard.forbidden;

    const limit = rateLimit(`dev-terminal:${guard.user.uid}`, { limit: 30, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Trop de commandes rapprochées. Réessayez dans quelques instants." }, { status: 429 });
    }

    const parsed = CommandSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Commande invalide.", issues: parsed.error.flatten() }, { status: 400 });
    }

    const result = await executeAgentTerminal({
      userId: guard.user.uid,
      executionId: randomUUID(),
      runtime: parsed.data.runtime ?? "node",
      command: parsed.data.command,
      cwd: parsed.data.cwd,
      timeoutMs: parsed.data.timeoutMs,
      memoryMb: parsed.data.memoryMb,
    });

    return NextResponse.json({
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      mode: result.mode,
      simulation: result.simulation ?? null,
      backend: { sandboxDeployed: isSandboxConfigured() },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Terminal indisponible.";
    if (/safety policy|too large|empty/i.test(message)) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json(errorBody(error, "Terminal indisponible."), { status: errorStatus(error) });
  }
}
