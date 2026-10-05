import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { errorStatus } from "@/lib/security/http-errors";
import { executeUserTerminalCommand } from "@/lib/agents/runtime/user-terminal";
import { isSandboxConfigured } from "@/lib/sandbox/simulation";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * TERMINAL UTILISATEUR — exécution directe (terminal intégré avancé).
 *
 * POST /api/terminal/exec — tout utilisateur authentifié exécute une
 * commande dans SON workspace d'exécution (persistant 24 h, propriété
 * Firestore). Garde-fous : deny-list agent-terminal, bornes temps/mémoire,
 * rate limit, session d'audit avec masquage des secrets. Mode renvoyé au
 * client (sandbox réelle si déployée, sinon simulation annoncée).
 */
const CommandSchema = z.object({
  command: z.string().min(1).max(20_000),
  workspaceId: z.string().trim().min(1).max(128).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  memoryMb: z.number().int().min(64).max(2_048).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);

    const limit = await enforceRateLimit(`user-terminal:${user.uid}`, { limit: 20, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Trop de commandes rapprochées. Réessayez dans quelques instants." },
        { status: 429, headers: { "retry-after": String(Math.ceil((limit.retryAfterMs ?? 60_000) / 1000)) } },
      );
    }

    const parsed = CommandSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Commande invalide.", issues: parsed.error.flatten() }, { status: 400 });
    }

    const result = await executeUserTerminalCommand({
      userId: user.uid,
      command: parsed.data.command,
      workspaceId: parsed.data.workspaceId,
      timeoutMs: parsed.data.timeoutMs,
      memoryMb: parsed.data.memoryMb,
    });

    return NextResponse.json({
      ok: result.execution.exitCode === 0,
      execution: {
        stdout: result.execution.stdout,
        stderr: result.execution.stderr,
        exitCode: result.execution.exitCode,
        durationMs: result.execution.durationMs,
        mode: result.execution.mode,
        simulation: result.execution.simulation ?? null,
      },
      workspace: result.workspace,
      sessionId: result.session?.id ?? null,
      sandboxDeployed: isSandboxConfigured(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Exécution impossible";
    return NextResponse.json({ error: message }, { status: errorStatus(error, 400) });
  }
}

/** GET /api/terminal/exec — état du service (mode d'exécution annoncé).
 * Auth requise : ne révèle ni la configuration sandbox ni le moteur à un
 * demandeur anonyme (surface de reconnaissance réduite). */
export async function GET(request: NextRequest) {
  try {
    await requireUser(request);
  } catch {
    return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  }
  return NextResponse.json({
    sandboxDeployed: isSandboxConfigured(),
    engine: isSandboxConfigured() ? "docker" : "simulation",
    requestId: randomUUID(),
  });
}
