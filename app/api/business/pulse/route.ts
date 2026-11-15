import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";
import { assertOrgAttach } from "@/lib/tenants/resource-access";
import { runBusinessPulse } from "@/lib/business/pulse";

/**
 * PULSE BUSINESS (concept post-SaaS #7 « Autonomous Business Cloud ») :
 * lecture des KPIs réels + lancement d'une mission d'analyse bornée
 * (recommandations, jamais de dépense). `dryRun: true` retourne les
 * indicateurs et l'objectif SANS lancer la mission.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PulseSchema = z.object({
  orgId: z.string().trim().min(1).max(128).optional(),
  dryRun: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    // Le pulse lance une mission agent complète (planificateur universel +
    // outils) : le domaine business limite ses routes à 120/5min — le POST
    // coûteux n'en avait aucune.
    const limit = await rateLimitDistributed(`business:pulse:${user.uid}`, { limit: 120, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes, réessayez dans un instant." }, { status: 429 });
    const parsed = PulseSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    if (parsed.data.orgId) {
      await assertOrgAttach(user.uid, parsed.data.orgId);
    }
    const result = await runBusinessPulse({
      userId: user.uid,
      ...(parsed.data.orgId ? { orgId: parsed.data.orgId } : {}),
      ...(parsed.data.dryRun !== undefined ? { dryRun: parsed.data.dryRun } : {}),
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Pulse impossible" },
      { status: errorStatus(error, 500) },
    );
  }
}
