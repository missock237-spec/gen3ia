import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { executionLogger, safeError } from "@/lib/observability/logger";
import { assertOrgAttach } from "@/lib/tenants/resource-access";
import { provisionFromIntent } from "@/lib/provisioning/intent";

/**
 * INTENT → INFRASTRUCTURE (concept post-SaaS #4) : une phrase suffit —
 * le système classe le besoin et met en place les ressources réelles
 * (agent, automatisation, planification, projet). `dryRun: true` retourne
 * la proposition sans exécution.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const IntentSchema = z.object({
  objective: z.string().trim().min(3).max(2_000),
  orgId: z.string().trim().min(1).max(128).optional(),
  dryRun: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  const log = executionLogger({ requestId: request.headers.get("x-request-id")?.trim() || "provisioning-intent" });
  try {
    const user = await requireUser(request);
    const parsed = IntentSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    if (parsed.data.orgId) {
      await assertOrgAttach(user.uid, parsed.data.orgId);
    }
    const result = await provisionFromIntent({
      userId: user.uid,
      ...(parsed.data.orgId ? { orgId: parsed.data.orgId } : {}),
      objective: parsed.data.objective,
      ...(parsed.data.dryRun !== undefined ? { dryRun: parsed.data.dryRun } : {}),
    });
    log.info({ event: "provisioning.intent", kind: result.plan.kind, executed: result.executed, userId: user.uid }, "Intent traité");
    return NextResponse.json(result);
  } catch (error) {
    log.warn({ event: "provisioning.intent.failed", error: safeError(error) }, "Provisionnement impossible");
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Provisionnement impossible" },
      { status: errorStatus(error, 502) },
    );
  }
}
